import type { Bucket } from '../../bucket.ts'
import { FileAction, type FileVersion } from '../../types/file.ts'
import type { FileId } from '../../types/ids.ts'
import { sanitizeErrorReason } from '../../util/error-reason.ts'
import {
  literalPrefixForSyncFilters,
  pathPassesSyncFilters,
  pathSkippedByRegExpInputLimit,
} from '../filters.ts'
import { isAbortError } from '../local-sha1.ts'
import { compareCodeUnits, compareSyncRelativePaths } from '../path-order.ts'
import {
  asRawB2KeyPrefix,
  b2KeyToRelativePathUnderPrefix,
  localFilesystemCanonicalSyncPath,
  localFilesystemSyncPathIsUnsafe,
} from '../prefix.ts'
import { validateSyncFilters } from '../regexp-safety.ts'
import { emitScannerSkip, regexpInputTooLongSkip } from '../scan-events.ts'
import { assertScanEntryLimit, scanEntryLimit } from '../scan-limit.ts'
import { selectB2ComparableSha1, syncSha1StateOf } from '../sha1-metadata.ts'
import type {
  B2SyncPath,
  SyncErrorEvent,
  SyncFolder,
  SyncScanOptions,
  SyncSkipReason,
} from '../types.ts'

const MAX_EMPTY_B2_SCAN_PAGES = 100

interface B2ScanEntry {
  relativePath: string
  versions: FileVersion[]
}

interface VisibleB2ScanEntry extends B2ScanEntry {
  fileName: string
  selectedVersion: FileVersion
}

/**
 * Scans a B2 bucket (optionally filtered by a raw B2 key prefix) and yields
 * {@link B2SyncPath} entries sorted by file name. Hidden files are excluded.
 * All versions for the listed prefix are fetched, grouped, and sorted before
 * yielding; exclude filters are applied client-side and do not reduce that
 * B2 listing memory footprint.
 */
export class B2Folder implements SyncFolder {
  readonly type = 'b2' as const
  readonly appliesScanFilters = true as const
  readonly appliesScanSorting = true as const
  /** Raw B2 key prefix this folder scans, preserving caller-provided separators verbatim. */
  readonly rawPrefix: string
  private readonly bucket: Bucket

  /**
   * Creates a new B2Folder for the given bucket and optional prefix.
   * @param bucket - The B2 bucket to scan.
   * @param prefix - Optional raw B2 key prefix to restrict the scan scope.
   * Backslashes are preserved as raw B2 key characters; pass `/` explicitly for slash prefixes.
   */
  constructor(bucket: Bucket, prefix = '') {
    this.bucket = bucket
    this.rawPrefix = asRawB2KeyPrefix(prefix)
  }

  /**
   * Lists all file versions in the bucket, groups by name, and yields the latest visible version.
   * @param options - Optional scan controls.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pagination, grouping, and filtering stay in one async iterator.
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<B2SyncPath> {
    validateSyncFilters(options)
    const maxScanEntries = scanEntryLimit(options)
    const grouped = new Map<string, B2ScanEntry>()
    const listPrefix = this.listPrefixFor(options)

    let listedVersions = 0
    let startFileName: string | undefined
    let startFileId: FileId | undefined
    let emptyPageCount = 0

    while (true) {
      if (scanIsAborted(options)) return

      let listing: Awaited<ReturnType<Bucket['listFileVersions']>>
      try {
        listing = await this.bucket.listFileVersions({
          ...(listPrefix !== '' ? { prefix: listPrefix } : {}),
          ...(startFileName !== undefined ? { startFileName } : {}),
          ...(startFileId !== undefined ? { startFileId } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (err) {
        if (scanIsAborted(options) || isAbortError(err)) return
        throw emitScanError(options, 'failed to scan B2 file versions', err)
      }
      if (scanIsAborted(options)) return

      if (listing.files.length === 0) {
        emptyPageCount++
        if (emptyPageCount > MAX_EMPTY_B2_SCAN_PAGES) {
          throw emitScanError(
            options,
            'failed to scan B2 file versions',
            new Error('B2 pagination returned too many empty pages'),
          )
        }
      } else {
        emptyPageCount = 0
      }

      for (const fv of listing.files) {
        if (scanIsAborted(options)) return
        assertScanEntryLimit(listedVersions + 1, maxScanEntries)
        listedVersions++

        // Real B2 honors the prefix in listFileVersions, but custom
        // transports and the simulator can over-return. Guard before
        // stripping the raw prefix so relativePath is never corrupted.
        if (this.rawPrefix !== '' && !fv.fileName.startsWith(this.rawPrefix)) {
          this.emitSkip(
            options,
            fv.fileName,
            fv.fileName,
            'outside-prefix',
            `listed object is outside configured B2 prefix ${JSON.stringify(this.rawPrefix)}`,
          )
          continue
        }

        const relativePath = this.tryToRelativePath(fv.fileName)
        if (relativePath === null) {
          this.emitSkip(
            options,
            fv.fileName,
            fv.fileName,
            'unsafe-name',
            'object name cannot be represented as a safe sync relative path',
          )
          continue
        }

        if (!pathPassesSyncFilters(relativePath, options)) {
          if (pathSkippedByRegExpInputLimit(relativePath, options)) {
            emitScannerSkip(options, {
              ...regexpInputTooLongSkip(relativePath),
              b2FileName: fv.fileName,
            })
          }
          continue
        }

        const existing = grouped.get(fv.fileName)
        if (existing) {
          existing.versions.push(fv)
        } else {
          grouped.set(fv.fileName, { relativePath, versions: [fv] })
        }
      }

      if (!listing.nextFileName) break
      if (
        listing.nextFileName === startFileName &&
        (listing.nextFileId ?? undefined) === startFileId
      ) {
        throw emitScanError(
          options,
          'failed to scan B2 file versions',
          new Error('B2 pagination did not advance'),
        )
      }
      startFileName = listing.nextFileName
      startFileId = listing.nextFileId ?? undefined
    }

    const visible = this.visibleCandidates(grouped, options)
    const withoutRelativeCollisions = this.rejectRelativePathCollisions(visible, options)
    const safeCandidates =
      options.requireLocalSafePaths === true
        ? this.rejectLocalPathCollisions(withoutRelativeCollisions, options)
        : withoutRelativeCollisions
    const sorted = safeCandidates.sort(
      (a, b) =>
        compareSyncRelativePaths(a.relativePath, b.relativePath) ||
        compareCodeUnits(a.fileName, b.fileName),
    )

    for (const { relativePath, versions, selectedVersion } of sorted) {
      if (scanIsAborted(options)) return
      const contentSha1 = selectB2ComparableSha1(selectedVersion)
      yield {
        relativePath,
        modTimeMillis: selectedVersion.uploadTimestamp,
        size: selectedVersion.contentLength,
        contentSha1,
        contentSha1State: syncSha1StateOf({ contentSha1 }),
        selectedVersion,
        allVersions: versions,
      }
    }
  }

  private tryToRelativePath(fileName: string): string | null {
    try {
      return b2KeyToRelativePathUnderPrefix(this.rawPrefix, fileName)
    } catch {
      return null
    }
  }

  private listPrefixFor(filters: SyncScanOptions | undefined): string {
    const filterPrefix = literalPrefixForSyncFilters(filters)
    if (filterPrefix === '') return this.rawPrefix
    if (this.rawPrefix !== '' && !this.rawPrefix.endsWith('/')) return this.rawPrefix
    return `${this.rawPrefix}${rawPrefixBeforeNormalizedSeparator(filterPrefix)}`
  }

  private visibleCandidates(
    grouped: Map<string, B2ScanEntry>,
    filters: SyncScanOptions | undefined,
  ): VisibleB2ScanEntry[] {
    const visible: VisibleB2ScanEntry[] = []

    for (const [fileName, entry] of grouped) {
      entry.versions.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
      const selected = entry.versions[0]
      if (!selected || selected.action === FileAction.Hide) continue

      if (
        filters?.requireLocalSafePaths === true &&
        localFilesystemSyncPathIsUnsafe(entry.relativePath)
      ) {
        this.emitSkip(
          filters,
          entry.relativePath,
          fileName,
          'local-unsafe-name',
          'object name is unsafe for a local filesystem destination',
        )
        continue
      }

      visible.push({
        fileName,
        relativePath: entry.relativePath,
        versions: entry.versions,
        selectedVersion: selected,
      })
    }

    return visible
  }

  private rejectRelativePathCollisions(
    candidates: VisibleB2ScanEntry[],
    filters: SyncScanOptions | undefined,
  ): VisibleB2ScanEntry[] {
    const accepted: VisibleB2ScanEntry[] = []
    const owners = new Map<string, VisibleB2ScanEntry>()
    const collidedRelativePaths = new Set<string>()

    for (const candidate of candidates) {
      if (collidedRelativePaths.has(candidate.relativePath)) {
        this.emitSkip(
          filters,
          candidate.relativePath,
          candidate.fileName,
          'relative-path-collision',
          'object normalizes to a relative path already rejected because of another raw B2 key',
        )
        continue
      }

      const owner = owners.get(candidate.relativePath)
      if (owner !== undefined && owner.fileName !== candidate.fileName) {
        owners.delete(candidate.relativePath)
        removeAcceptedCandidate(accepted, owner)
        collidedRelativePaths.add(candidate.relativePath)
        this.emitSkip(
          filters,
          candidate.relativePath,
          owner.fileName,
          'relative-path-collision',
          `object normalizes to the same relative path as ${JSON.stringify(candidate.fileName)}`,
        )
        this.emitSkip(
          filters,
          candidate.relativePath,
          candidate.fileName,
          'relative-path-collision',
          `object normalizes to the same relative path as ${JSON.stringify(owner.fileName)}`,
        )
        continue
      }

      owners.set(candidate.relativePath, candidate)
      accepted.push(candidate)
    }

    return accepted
  }

  private rejectLocalPathCollisions(
    candidates: VisibleB2ScanEntry[],
    filters: SyncScanOptions | undefined,
  ): VisibleB2ScanEntry[] {
    const accepted: VisibleB2ScanEntry[] = []
    const owners = new Map<string, VisibleB2ScanEntry>()
    const collidedLocalPaths = new Set<string>()

    for (const candidate of candidates) {
      const canonicalPath = localFilesystemCanonicalSyncPath(candidate.relativePath)
      if (collidedLocalPaths.has(canonicalPath)) {
        this.emitSkip(
          filters,
          candidate.relativePath,
          candidate.fileName,
          'local-path-collision',
          'object collides with another object on case-insensitive or Unicode-normalizing filesystems',
        )
        continue
      }

      const owner = owners.get(canonicalPath)
      if (owner !== undefined) {
        owners.delete(canonicalPath)
        removeAcceptedCandidate(accepted, owner)
        collidedLocalPaths.add(canonicalPath)
        this.emitSkip(
          filters,
          owner.relativePath,
          owner.fileName,
          'local-path-collision',
          `object collides with ${JSON.stringify(candidate.fileName)} on local filesystems`,
        )
        this.emitSkip(
          filters,
          candidate.relativePath,
          candidate.fileName,
          'local-path-collision',
          `object collides with ${JSON.stringify(owner.fileName)} on local filesystems`,
        )
        continue
      }

      owners.set(canonicalPath, candidate)
      accepted.push(candidate)
    }

    return accepted
  }

  private emitSkip(
    filters: SyncScanOptions | undefined,
    path: string,
    b2FileName: string,
    reason: SyncSkipReason,
    message: string,
  ): void {
    emitScannerSkip(filters, {
      type: 'skip',
      path,
      size: 0,
      message: `Skipped B2 object ${JSON.stringify(b2FileName)}: ${message}`,
      reason,
      b2FileName,
    })
  }
}

function rawPrefixBeforeNormalizedSeparator(filterPrefix: string): string {
  const separatorIndex = filterPrefix.indexOf('/')
  return separatorIndex === -1 ? filterPrefix : filterPrefix.slice(0, separatorIndex)
}

function emitScanError(options: SyncScanOptions, message: string, err: unknown): Error {
  const event: SyncErrorEvent = {
    type: 'error',
    path: '',
    size: 0,
    message: `${message}: ${sanitizeErrorReason(err)}`,
  }
  options.onError?.(event)
  return new Error(event.message)
}

function removeAcceptedCandidate(
  candidates: VisibleB2ScanEntry[],
  target: VisibleB2ScanEntry,
): void {
  const index = candidates.indexOf(target)
  if (index !== -1) candidates.splice(index, 1)
}

function scanIsAborted(filters: SyncScanOptions | undefined): boolean {
  return filters?.signal?.aborted === true
}
