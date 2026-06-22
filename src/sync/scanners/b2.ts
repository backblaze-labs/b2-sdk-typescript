import type { Bucket } from '../../bucket.ts'
import { FileAction, type FileVersion } from '../../types/file.ts'
import { sanitizeErrorReason } from '../../util/error-reason.ts'
import { isAbortError } from '../local-sha1.ts'
import { compareSyncPathNames } from '../path-order.ts'
import { selectB2ComparableSha1, syncSha1StateOf } from '../sha1-metadata.ts'
import type { B2SyncPath, SyncErrorEvent, SyncFolder, SyncScanOptions } from '../types.ts'

/**
 * Scans a B2 bucket (optionally filtered by prefix) and yields {@link B2SyncPath} entries
 * sorted by deterministic file-name order. Hidden files are excluded. All versions are fetched
 * and grouped.
 */
export class B2Folder implements SyncFolder {
  readonly type = 'b2' as const
  private readonly bucket: Bucket
  private readonly prefix: string

  /**
   * Creates a new B2Folder for the given bucket and optional prefix.
   * @param bucket - The B2 bucket to scan.
   * @param prefix - Optional key prefix to restrict the scan scope.
   */
  constructor(bucket: Bucket, prefix = '') {
    this.bucket = bucket
    this.prefix = prefix
  }

  /**
   * Lists all file versions in the bucket, groups by name, and yields the latest visible version.
   * @param options - Optional scan controls.
   */
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<B2SyncPath> {
    const grouped = new Map<string, FileVersion[]>()

    let startFileName: string | undefined
    let startFileId: string | undefined

    while (true) {
      if (options.signal?.aborted) return

      let listing: Awaited<ReturnType<Bucket['listFileVersions']>>
      try {
        listing = await this.bucket.listFileVersions({
          ...(this.prefix !== '' ? { prefix: this.prefix } : {}),
          ...(startFileName !== undefined ? { startFileName } : {}),
          ...(startFileId !== undefined
            ? { startFileId: startFileId as import('../../types/ids.ts').FileId }
            : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
      } catch (err) {
        if (options.signal?.aborted || isAbortError(err)) return
        throw emitScanError(options, 'failed to scan B2 file versions', err)
      }

      for (const fv of listing.files) {
        if (options.signal?.aborted) return

        const existing = grouped.get(fv.fileName)
        if (existing) {
          existing.push(fv)
        } else {
          grouped.set(fv.fileName, [fv])
        }
      }

      if (!listing.nextFileName) break
      startFileName = listing.nextFileName
      startFileId = listing.nextFileId ?? undefined
    }

    const sorted = [...grouped.entries()].sort((a, b) => compareSyncPathNames(a[0], b[0]))

    for (const [fileName, versions] of sorted) {
      if (options.signal?.aborted) return

      versions.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
      const selected = versions[0]
      if (!selected || selected.action === FileAction.Hide) continue

      const relativePath = this.prefix !== '' ? fileName.slice(this.prefix.length) : fileName

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
