import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import { type FileVersion, MetadataDirective } from '../types/file.ts'
import { type BucketId, type FileId, fileId as fileIdOf } from '../types/ids.ts'
import { cancelLargeFileBestEffort } from '../upload/cancel.ts'
import { Semaphore } from '../upload/concurrency.ts'
import { DEFAULT_CONTENT_TYPE, DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { byteRangeHeader, planRanges } from '../util/plan-ranges.ts'

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
  /**
   * Maximum number of parts copied in parallel. Defaults to
   * {@link DEFAULT_TRANSFER_CONCURRENCY}.
   */
  readonly concurrency?: number
  /** MIME type for the destination file. Defaults to `b2/x-auto`. */
  readonly contentType?: string
  /** Custom file info merged into the destination. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption applied to the destination. */
  readonly destinationServerSideEncryption?: EncryptionSetting
  /** SSE-C settings used to read the source if it was uploaded with SSE-C. */
  readonly sourceServerSideEncryption?: EncryptionSetting
  /**
   * Optional abort signal. Checked before dispatching each part and
   * between parts; an aborted signal cancels remaining parts and rolls
   * back the unfinished large file via best-effort `cancelLargeFile`.
   *
   * Aborting does NOT roll back parts already accepted by B2; those
   * exist on the unfinished large file until the cancel call completes
   * or B2's lifecycle expires the in-progress upload (24 hours).
   */
  readonly signal?: AbortSignal
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
  const concurrency = options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY

  // Discover the source size via getFileInfo.
  const sourceInfo = await raw.getFileInfo(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    fileId: options.sourceFileId,
  })
  const totalSize = sourceInfo.contentLength

  // Below the part threshold, take the single-call fast path.
  if (totalSize <= partSize) {
    // `b2_copy_file` only accepts replacement contentType/fileInfo under
    // `metadataDirective: REPLACE`; supplying them in the default COPY mode is
    // rejected by B2. When the caller sets either, switch to REPLACE with a
    // required contentType (the override, else the source's, else b2/x-auto),
    // matching the multipart path's metadata semantics below.
    const replaceMetadata = options.contentType !== undefined || options.fileInfo !== undefined
    return raw.copyFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      sourceFileId: options.sourceFileId,
      fileName: options.fileName,
      ...(options.destinationBucketId !== undefined
        ? { destinationBucketId: options.destinationBucketId }
        : {}),
      ...(replaceMetadata
        ? {
            metadataDirective: MetadataDirective.Replace,
            contentType: options.contentType ?? sourceInfo.contentType ?? DEFAULT_CONTENT_TYPE,
            fileInfo: options.fileInfo ?? {},
          }
        : {}),
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
    contentType: options.contentType ?? sourceInfo.contentType ?? DEFAULT_CONTENT_TYPE,
    fileInfo: options.fileInfo ?? {},
    ...(options.destinationServerSideEncryption !== undefined
      ? { serverSideEncryption: options.destinationServerSideEncryption }
      : {}),
  })
  const largeFileId = startResp.fileId

  const ranges = planRanges(totalSize, partSize)
  const partSha1s: string[] = new Array(ranges.length)
  const sem = new Semaphore(concurrency)

  try {
    options.signal?.throwIfAborted()
    await Promise.all(
      ranges.map(async (range) => {
        await sem.acquire()
        try {
          // Re-check the abort flag after every queue handoff so the
          // first cancelled task short-circuits the remaining parts.
          options.signal?.throwIfAborted()
          const resp = await raw.copyPart(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
            sourceFileId: options.sourceFileId,
            // `startLargeFile` returns `LargeFileId`; `copyPart` takes the
            // same value typed as `FileId`. Re-brand via the factory.
            largeFileId: fileIdOf(largeFileId),
            partNumber: range.partNumber,
            range: byteRangeHeader(range.start, range.end),
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

    options.signal?.throwIfAborted()
    return await raw.finishLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId: largeFileId,
      partSha1Array: partSha1s,
    })
  } catch (err) {
    await cancelLargeFileBestEffort(
      raw,
      accountInfo,
      largeFileId,
      options.signal === undefined ? undefined : { signal: options.signal },
    )
    throw err
  }
}
