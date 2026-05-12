import type { Bucket } from '../../bucket.ts'
import type { FileVersion } from '../../types/file.ts'
import type { B2SyncPath, SyncFolder } from '../types.ts'

/**
 * Scans a B2 bucket (optionally filtered by prefix) and yields {@link B2SyncPath} entries
 * sorted by file name. Hidden files are excluded. All versions are fetched and grouped.
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

  /** Lists all file versions in the bucket, groups by name, and yields the latest visible version. */
  async *scan(): AsyncGenerator<B2SyncPath> {
    const grouped = new Map<string, FileVersion[]>()

    let startFileName: string | undefined
    let startFileId: string | undefined

    for (;;) {
      const listing = await this.bucket.listFileVersions({
        ...(this.prefix !== '' ? { prefix: this.prefix } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
        ...(startFileId !== undefined
          ? { startFileId: startFileId as import('../../types/ids.ts').FileId }
          : {}),
      })

      for (const fv of listing.files) {
        const existing = grouped.get(fv.fileName)
        if (existing) {
          existing.push(fv)
        } else {
          grouped.set(fv.fileName, [fv])
        }
      }

      if (!listing.nextFileName) break
      startFileName = listing.nextFileName
      startFileId = listing.nextFileId as string | undefined
    }

    const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))

    for (const [fileName, versions] of sorted) {
      versions.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)
      const selected = versions[0]
      if (!selected || selected.action === 'hide') continue

      const relativePath = this.prefix !== '' ? fileName.slice(this.prefix.length) : fileName

      yield {
        relativePath,
        modTimeMillis: selected.uploadTimestamp,
        size: selected.contentLength,
        selectedVersion: selected,
        allVersions: versions,
      }
    }
  }
}
