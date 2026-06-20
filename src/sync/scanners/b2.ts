import type { Bucket } from '../../bucket.ts'
import { FileAction, type FileVersion } from '../../types/file.ts'
import type { FileId } from '../../types/ids.ts'
import { sanitizeErrorReason } from '../../util/error-reason.ts'
import { isAbortError } from '../local-sha1.ts'
import {
  literalPrefixForSyncFilters,
  pathPassesSyncFilters,
  pathSkippedByRegExpInputLimit,
} from '../filters.ts'
import { compareSyncRelativePaths } from '../path-order.ts'
import { asRawB2KeyPrefix, normalizeB2RelativePath } from '../prefix.ts'
import { validateSyncFilters } from '../regexp-safety.ts'
import { emitScannerSkip, regexpInputTooLongSkip } from '../scan-events.ts'
import { selectB2ComparableSha1, syncSha1StateOf } from '../sha1-metadata.ts'
import type {
  B2SyncPath,
  SyncErrorEvent,
  SyncFolder,
  SyncScanOptions,
  SyncSkipReason,
} from '../types.ts'

interface B2ScanEntry {
  relativePath: string
  versions: FileVersion[]
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
  private readonly bucket: Bucket
  private readonly prefix: string

  /**
   * Creates a new B2Folder for the given bucket and optional prefix.
   * @param bucket - The B2 bucket to scan.
   * @param prefix - Optional raw B2 key prefix to restrict the scan scope.
   * Backslashes are preserved as raw B2 key characters; pass `/` explicitly for slash prefixes.
   */
  constructor(bucket: Bucket, prefix = '') {
    this.bucket = bucket
    this.prefix = asRawB2KeyPrefix(prefix)
  }

  /**
   * Lists all file versions in the bucket, groups by name, and yields the latest visible version.
   * @param options - Optional scan controls.
   */
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<B2SyncPath> {
    validateSyncFilters(options)
    const grouped = new Map<string, B2ScanEntry>()
    const relativePathOwners = new Map<string, string>()
    const collidedRelativePaths = new Set<string>()
    const listPrefix = this.listPrefixFor(options)

    let startFileName: string | undefined
    let startFileId: FileId | undefined

    while (true) {
      if (options.signal?.aborted) return

      let listing: Awaited<ReturnType<Bucket['listFileVersions']>>
      try {
        listing = await this.bucket.listFileVersions({
          ...(listPrefix !== '' ? { prefix: listPrefix } : {}),
          ...(startFileName !== undefined ? { startFileName } : {}),
          ...(startFileId !== undefined ? { startFileId } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (err) {
        if (options.signal?.aborted || isAbortError(err)) return
        throw emitScanError(options, 'failed to scan B2 file versions', err)
      }

      for (const fv of listing.files) {
        if (options.signal?.aborted) return

        // Real B2 honors the prefix in listFileVersions, but custom
        // transports and the simulator can over-return. Guard before
        // stripping this.prefix so relativePath is never corrupted.
        if (this.prefix !== '' && !fv.fileName.startsWith(this.prefix)) {
          this.emitSkip(
            options,
            fv.fileName,
            fv.fileName,
            'outside-prefix',
            `listed object is outside configured B2 prefix ${JSON.stringify(this.prefix)}`,
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

        if (collidedRelativePaths.has(relativePath)) {
          this.emitSkip(
            options,
            relativePath,
            fv.fileName,
            'relative-path-collision',
            'object normalizes to a relative path already rejected because of another raw B2 key',
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

        const owner = relativePathOwners.get(relativePath)
        if (owner !== undefined && owner !== fv.fileName) {
          grouped.delete(owner)
          relativePathOwners.delete(relativePath)
          collidedRelativePaths.add(relativePath)
          this.emitSkip(
            options,
            relativePath,
            owner,
            'relative-path-collision',
            `object normalizes to the same relative path as ${JSON.stringify(fv.fileName)}`,
          )
          this.emitSkip(
            options,
            relativePath,
            fv.fileName,
            'relative-path-collision',
            `object normalizes to the same relative path as ${JSON.stringify(owner)}`,
          )
          continue
        }

        const existing = grouped.get(fv.fileName)
        if (existing) {
          existing.versions.push(fv)
        } else {
          grouped.set(fv.fileName, { relativePath, versions: [fv] })
          relativePathOwners.set(relativePath, fv.fileName)
        }
      }

      if (!listing.nextFileName) break
      startFileName = listing.nextFileName
      startFileId = listing.nextFileId ?? undefined
    }

    const sorted = [...grouped.entries()].sort(
      (a, b) =>
        compareSyncRelativePaths(a[1].relativePath, b[1].relativePath) ||
        compareSyncRelativePaths(a[0], b[0]),
    )

    for (const [, { relativePath, versions }] of sorted) {
      if (options.signal?.aborted) return
      versions.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
      const selected = versions[0]
      if (!selected || selected.action === FileAction.Hide) continue

      const contentSha1 = selectB2ComparableSha1(selected)
      yield {
        relativePath,
        modTimeMillis: selected.uploadTimestamp,
        size: selected.contentLength,
        contentSha1,
        contentSha1State: syncSha1StateOf({ contentSha1 }),
        selectedVersion: selected,
        allVersions: versions,
      }
    }
  }

  private tryToRelativePath(fileName: string): string | null {
    try {
      const suffix = this.prefix === '' ? fileName : fileName.slice(this.prefix.length)
      return normalizeB2RelativePath(suffix, {
        stripLeadingSlashes: this.prefix !== '' && !this.prefix.endsWith('/'),
      })
    } catch {
      return null
    }
  }

  private listPrefixFor(filters: SyncScanOptions | undefined): string {
    const filterPrefix = literalPrefixForSyncFilters(filters)
    if (filterPrefix === '') return this.prefix
    if (this.prefix !== '' && !this.prefix.endsWith('/')) return this.prefix
    return `${this.prefix}${rawPrefixBeforeNormalizedSeparator(filterPrefix)}`
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
