import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import { type BucketId, type FileId, fileId as fileIdOf } from '../types/ids.ts'
import { Semaphore } from '../upload/concurrency.ts'
import { bestEffort } from '../util/best-effort.ts'

/** Options for a server-side multipart copy. */
export interface CopyLargeFileOptions {
  /** ID of the source file version to copy. */
  readonly sourceFileId: FileId
  /** Destination file name in the target bucket. */
  readonly fileName: string
  /** Target bucket. Defaults to the source's bucket. */
  readonly destinationBucketId?: BucketId
  /** Size of each part in bytes. Defaults to the account's recommended part size. */
  readonly partSize?: number
  /** Maximum number of parts copied in parallel. Defaults to 4. */
  readonly concurrency?: number
  /** MIME type for the destination file. Defaults to `b2/x-auto`. */
  readonly contentType?: string
  /** Custom file info merged into the destination. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption applied to the destination. */
  readonly destinationServerSideEncryption?: EncryptionSetting
  /** SSE-C settings used to read the source if it was uploaded with SSE-C. */
  readonly sourceServerSideEncryption?: EncryptionSetting
}

/**
 * Performs a server-side copy of a file using the multipart `b2_copy_part` protocol.
 * The source bytes never traverse the client; B2 copies each range internally.
 *
 * Falls back to a single `copyFile` call when the source fits in one part.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state (used to resolve API URL, recommended part size).
 * @param options - Copy parameters including source, destination, and concurrency.
 *
 * @returns The resulting destination {@link FileVersion}.
 */
export async function copyLargeFile(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: CopyLargeFileOptions,
): Promise<FileVersion> {
  const recommendedPartSize = accountInfo.getRecommendedPartSize()
  const minPartSize = accountInfo.getAbsoluteMinimumPartSize()
  const partSize = Math.max(options.partSize ?? recommendedPartSize, minPartSize)
  const concurrency = options.concurrency ?? 4

  // Discover the source size via getFileInfo.
  const sourceInfo = await raw.getFileInfo(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    fileId: options.sourceFileId,
  })
  const totalSize = sourceInfo.contentLength

  // Below the part threshold, take the single-call fast path.
  if (totalSize <= partSize) {
    return raw.copyFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      sourceFileId: options.sourceFileId,
      fileName: options.fileName,
      ...(options.destinationBucketId !== undefined
        ? { destinationBucketId: options.destinationBucketId }
        : {}),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.fileInfo !== undefined ? { fileInfo: options.fileInfo } : {}),
      ...(options.destinationServerSideEncryption !== undefined
        ? { destinationServerSideEncryption: options.destinationServerSideEncryption }
        : {}),
      ...(options.sourceServerSideEncryption !== undefined
        ? { sourceServerSideEncryption: options.sourceServerSideEncryption }
        : {}),
    })
  }

  // Resolve destination bucket (defaults to source's bucket). Both operands
  // are already typed `BucketId`, so no cast is needed.
  const destBucketId = options.destinationBucketId ?? sourceInfo.bucketId

  // Start the multipart file.
  const startResp = await raw.startLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    bucketId: destBucketId,
    fileName: options.fileName,
    contentType: options.contentType ?? sourceInfo.contentType ?? 'b2/x-auto',
    fileInfo: options.fileInfo ?? {},
    ...(options.destinationServerSideEncryption !== undefined
      ? { serverSideEncryption: options.destinationServerSideEncryption }
      : {}),
  })
  const largeFileId = startResp.fileId

  // Plan part ranges.
  const ranges: { partNumber: number; start: number; end: number }[] = []
  let offset = 0
  let partNumber = 1
  while (offset < totalSize) {
    const end = Math.min(offset + partSize - 1, totalSize - 1)
    ranges.push({ partNumber, start: offset, end })
    offset = end + 1
    partNumber++
  }

  const partSha1s: string[] = new Array(ranges.length)
  const sem = new Semaphore(concurrency)

  try {
    await Promise.all(
      ranges.map(async (range) => {
        await sem.acquire()
        try {
          const resp = await raw.copyPart(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
            sourceFileId: options.sourceFileId,
            // `startLargeFile` returns `LargeFileId`; `copyPart` takes the
            // same value typed as `FileId`. Re-brand via the factory.
            largeFileId: fileIdOf(largeFileId),
            partNumber: range.partNumber,
            range: `bytes=${range.start}-${range.end}`,
            ...(options.sourceServerSideEncryption !== undefined
              ? { sourceServerSideEncryption: options.sourceServerSideEncryption }
              : {}),
            ...(options.destinationServerSideEncryption !== undefined
              ? { destinationServerSideEncryption: options.destinationServerSideEncryption }
              : {}),
          })
          partSha1s[range.partNumber - 1] = resp.contentSha1
        } finally {
          sem.release()
        }
      }),
    )

    return await raw.finishLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId: largeFileId,
      partSha1Array: partSha1s,
    })
  } catch (err) {
    await bestEffort(() =>
      raw.cancelLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
        fileId: largeFileId,
      }),
    )
    throw err
  }
}
