import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import { type ProgressListener, ProgressTracker } from '../streams/progress.ts'
import type { ContentSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import { DEFAULT_CONTENT_TYPE } from '../util/defaults.ts'

/** Options for uploading a small file in a single HTTP request. */
export interface UploadFileOptions {
  /** Target bucket for the upload. */
  readonly bucketId: BucketId
  /** Full B2 file name including any path prefix. */
  readonly fileName: string
  /** Content to upload. */
  readonly source: ContentSource
  /** MIME type. Defaults to `b2/x-auto` for server-side detection. */
  readonly contentType?: string
  /** Custom file info key/value pairs stored with the file. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption settings. */
  readonly serverSideEncryption?: EncryptionSetting
  /** File retention policy applied at upload time. */
  readonly fileRetention?: FileRetentionValue
  /** Legal hold status applied at upload time. */
  readonly legalHold?: LegalHoldValue
  /** Override the last-modified timestamp (epoch millis). */
  readonly lastModifiedMillis?: number
  /** Callback invoked with upload progress updates. */
  readonly onProgress?: ProgressListener
  /** Signal to abort the upload. */
  readonly signal?: AbortSignal
}

/**
 * Uploads a file in a single HTTP request (suitable for files up to ~100 MB).
 *
 * The entire file content is read into memory, SHA-1 hashed, and sent in one
 * `b2_upload_file` call. For files larger than the recommended part size, use
 * {@link uploadLargeFile} which splits the file into parts uploaded in parallel.
 *
 * Upload URLs are pooled via {@link AccountInfo} and recycled on success or
 * evicted on failure.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state (tokens, URLs, upload URL pool).
 * @param options - Upload parameters.
 *
 * @returns The resulting {@link FileVersion} metadata.
 */
export async function uploadSmallFile(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadFileOptions,
): Promise<FileVersion> {
  let uploadEntry = accountInfo.checkoutUploadUrl(options.bucketId)

  if (!uploadEntry) {
    const resp = await raw.getUploadUrl(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      bucketId: options.bucketId,
    })
    uploadEntry = { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
  }

  const data = new Uint8Array(await options.source.toArrayBuffer())
  const sha1 = new IncrementalSha1()
  await sha1.update(data)
  const sha1Hex = await sha1.digest()

  // Single-request uploads send the whole payload in one shot, so the
  // tracker reports a single "part" worth of progress: one byte burst at
  // completion and a parts-completed transition from 0 → 1. The tracker
  // is created (rather than calling the listener directly) so consumers
  // see the same {bytesTransferred, totalBytes, partsCompleted,
  // totalParts, elapsedMs} shape they get from `uploadLargeFile`.
  const tracker = new ProgressTracker(options.onProgress, data.byteLength, 1)

  try {
    const result = await raw.uploadFile(
      uploadEntry.uploadUrl,
      {
        authorization: uploadEntry.authorizationToken,
        fileName: options.fileName,
        contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
        contentLength: data.byteLength,
        contentSha1: sha1Hex,
        ...(options.fileInfo !== undefined ? { fileInfo: options.fileInfo } : {}),
        ...(options.serverSideEncryption !== undefined
          ? { serverSideEncryption: options.serverSideEncryption }
          : {}),
        ...(options.fileRetention !== undefined ? { fileRetention: options.fileRetention } : {}),
        ...(options.legalHold !== undefined ? { legalHold: options.legalHold } : {}),
        ...(options.lastModifiedMillis !== undefined
          ? { lastModifiedMillis: options.lastModifiedMillis }
          : {}),
      },
      data,
      options.signal,
    )

    tracker.addBytes(data.byteLength)
    tracker.completePart()
    accountInfo.returnUploadUrl(options.bucketId, uploadEntry)
    return result
  } catch (err) {
    accountInfo.evictUploadUrl(options.bucketId, uploadEntry)
    throw err
  }
}
