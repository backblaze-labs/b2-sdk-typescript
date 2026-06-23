import type { Bucket } from './bucket.ts'
import type { B2Client } from './client.ts'
import { createParallelDownloadStream } from './download/parallel.ts'
import {
  type DownloadResult,
  downloadById,
  downloadByName,
  type HeadResult,
  headById,
  headByName,
} from './download/single.ts'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from './http/retry.ts'
import type { SseCDownloadKey } from './raw/index.ts'
import type { ProgressListener } from './streams/progress.ts'
import type { ContentSource } from './streams/source.ts'
import type { EncryptionSetting } from './types/encryption.ts'
import type { FileVersion } from './types/file.ts'
import type { FileId } from './types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.ts'
import {
  type ResumePartReusedListener,
  type UploadLargeFileOptions,
  uploadLargeFile,
} from './upload/large.ts'
import type { ResumeCandidateRejectedListener } from './upload/resume.ts'
import type { UploadRetryListener } from './upload/retry.ts'
import { uploadSmallFile } from './upload/single.ts'
import { createWriteStream, type UploadWriteHandle } from './upload/stream.ts'

/** Options accepted by {@link B2Object.download} and {@link B2Object.downloadById}. */
export interface DownloadCallOptions {
  /**
   * HTTP method. Defaults to `'GET'`. Use `'HEAD'` to fetch only
   * response headers. Prefer the dedicated {@link B2Object.head} /
   * {@link Bucket.head} method over this option — those return a
   * body-less result so callers never have to remember to drain the
   * empty body of a HEAD response.
   */
  readonly method?: 'GET' | 'HEAD'
  /** HTTP Range header value (e.g., `"bytes=0-999"`). */
  readonly range?: string
  /** SSE-C decryption parameters, required if the file was uploaded with SSE-C. */
  readonly serverSideEncryption?: SseCDownloadKey
  /** Override the response `Content-Disposition` header. */
  readonly b2ContentDisposition?: string
  /** Override the response `Content-Language` header. */
  readonly b2ContentLanguage?: string
  /** Override the response `Content-Encoding` header. */
  readonly b2ContentEncoding?: string
  /** Override the response `Content-Type` header. */
  readonly b2ContentType?: string
  /** Override the response `Cache-Control` header. */
  readonly b2CacheControl?: string
  /** Override the response `Expires` header. */
  readonly b2Expires?: string
  /** Abort signal for cancelling the download. */
  readonly signal?: AbortSignal
  /**
   * Callback invoked as the response body is consumed.
   *
   * Progress is byte-driven, not request-driven: the callback fires per
   * chunk as the caller reads the returned `body` stream, and the final
   * `partsCompleted: 1` event only fires once the stream is read to
   * completion. Downloads that are dropped or aborted partway through
   * will NOT emit a `completePart()` event.
   */
  readonly onProgress?: ProgressListener
}

/**
 * Options accepted by {@link B2Object.head} / {@link Bucket.head}.
 * Same shape as {@link DownloadCallOptions} minus `method` (always
 * HEAD) and `onProgress` (no body to track).
 */
export type HeadCallOptions = Omit<DownloadCallOptions, 'method' | 'onProgress'>

/**
 * Handle to a specific file (by name) within a B2 bucket.
 *
 * Provides file-scoped upload, download, and management operations.
 * Obtained via {@link Bucket.file}.
 *
 * @example
 * ```ts
 * const obj = bucket.file('photos/2026/sunset.jpg')
 * await obj.upload({ source: new BufferSource(data) })
 * const result = await obj.download()
 * ```
 */
export class B2Object {
  /** The file name (path) within the bucket. */
  readonly fileName: string
  private readonly client: B2Client
  private readonly bucket: Bucket
  private readonly uploadRetryOptions: RetryOptions

  /**
   * @param client - The parent B2Client instance.
   * @param bucket - The parent Bucket this object belongs to.
   * @param fileName - The file path within the bucket.
   * @param uploadRetryOptions - Resolved retry settings for upload-layer retries.
   *
   * @internal
   */
  constructor(
    client: B2Client,
    bucket: Bucket,
    fileName: string,
    uploadRetryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  ) {
    this.client = client
    this.bucket = bucket
    this.fileName = fileName
    this.uploadRetryOptions = uploadRetryOptions
  }

  /**
   * Uploads data to this file name. Automatically uses multipart upload for large files.
   * @param options - Upload configuration including data source and optional settings.
   *
   * @returns Metadata for the uploaded file version.
   */
  async upload(options: {
    /** Data source to upload. */
    source: ContentSource
    /** MIME type. Defaults to auto-detection by B2. */
    contentType?: string
    /** Custom key-value metadata stored with the file. */
    fileInfo?: Record<string, string>
    /** Server-side encryption settings. */
    serverSideEncryption?: EncryptionSetting
    /** File retention policy (requires file lock). */
    fileRetention?: FileRetentionValue
    /** Legal hold status. */
    legalHold?: LegalHoldValue
    /** Last-modified timestamp in milliseconds since epoch. */
    lastModifiedMillis?: number
    /** Part size override for multipart uploads, in bytes. */
    partSize?: number
    /** Number of concurrent part uploads for large files. */
    concurrency?: number
    /** Callback invoked with upload progress events. */
    onProgress?: ProgressListener
    /** Callback invoked before retrying with a fresh upload URL. */
    onUploadRetry?: UploadRetryListener
    /**
     * Retry when an upload response body cannot be read after B2 may have stored
     * the payload. Single-request uploads default to false because this ambiguous
     * retry can create duplicate file versions; retryable 5xx responses and
     * network failures may still retry unless `retry.maxRetries` is 0.
     * If enabled for a single-request upload, file retention and legal hold
     * settings apply to each duplicate version and can prevent deletion until
     * retention expires or the hold is cleared.
     * Multipart part uploads default to true because re-posting the same part
     * number is idempotent.
     */
    retryResponseBodyFailures?: boolean
    /** Abort signal for cancelling the upload. */
    signal?: AbortSignal
    /** See {@link UploadLargeFileOptions.resume}. Ignored on the small-file path. */
    resume?: NonNullable<UploadLargeFileOptions['resume']>
    /** See {@link UploadLargeFileOptions.resumeMaxListPages}. */
    resumeMaxListPages?: NonNullable<UploadLargeFileOptions['resumeMaxListPages']>
    /** See {@link UploadLargeFileOptions.resumeMaxPartCandidates}. */
    resumeMaxPartCandidates?: NonNullable<UploadLargeFileOptions['resumeMaxPartCandidates']>
    /** See {@link UploadLargeFileOptions.resumeMaxPartPages}. */
    resumeMaxPartPages?: NonNullable<UploadLargeFileOptions['resumeMaxPartPages']>
    /**
     * See {@link UploadLargeFileOptions.resumeFileId}. Only supported on the
     * large-file path; small-file uploads throw.
     */
    resumeFileId?: NonNullable<UploadLargeFileOptions['resumeFileId']>
    /** Diagnostic callback invoked when resume discovery rejects a candidate. */
    onResumeCandidateRejected?: ResumeCandidateRejectedListener
    /** Diagnostic callback invoked when resume reuses an already-uploaded part. */
    onResumePartReused?: ResumePartReusedListener
  }): Promise<FileVersion> {
    const recommendedPartSize = this.client.accountInfo.getRecommendedPartSize()
    const isLarge = options.source.size > recommendedPartSize

    if (isLarge) {
      return uploadLargeFile(this.client.raw, this.client.accountInfo, {
        ...options,
        bucketId: this.bucket.id,
        fileName: this.fileName,
        retry: this.uploadRetryOptions,
      })
    }
    if (options.resumeFileId !== undefined) {
      throw new Error('B2Object.upload: resumeFileId is only supported for multipart uploads.')
    }

    // Small-file path doesn't accept resume options.
    const {
      resume: _resume,
      resumeFileId: _resumeFileId,
      onResumeCandidateRejected: _onResumeCandidateRejected,
      onResumePartReused: _onResumePartReused,
      resumeMaxListPages: _resumeMaxListPages,
      resumeMaxPartCandidates: _resumeMaxPartCandidates,
      resumeMaxPartPages: _resumeMaxPartPages,
      ...smallOptions
    } = options
    return uploadSmallFile(this.client.raw, this.client.accountInfo, {
      ...smallOptions,
      bucketId: this.bucket.id,
      fileName: this.fileName,
      retry: this.uploadRetryOptions,
    })
  }

  /**
   * Downloads this file by name. Pass `method: 'HEAD'` to fetch only the
   * response headers (file metadata) without streaming the body.
   * @param options - Optional method, range, SSE-C decryption, response-header overrides, and abort signal.
   *
   * @returns The download result with response headers and body stream.
   */
  async download(options?: DownloadCallOptions): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.bucket.name,
      fileName: this.fileName,
      ...options,
    })
  }

  /**
   * Fetches response headers for this file via HTTP HEAD. Returns a
   * body-less result so callers never have to drain the (logically
   * empty) HEAD body themselves.
   *
   * @param options - Optional range, SSE-C decryption, response-header
   *   overrides, and abort signal. Same shape as {@link B2Object.download}'s
   *   options minus `method` (always HEAD) and `onProgress` (no body).
   *
   * @returns Parsed download headers (content type, SHA-1, file info, etc.).
   */
  async head(options?: HeadCallOptions): Promise<HeadResult> {
    return headByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.bucket.name,
      fileName: this.fileName,
      ...options,
    })
  }

  /**
   * Downloads a specific version of this file by ID. Pass `method: 'HEAD'`
   * to fetch only the response headers (file metadata) without streaming the body.
   * @param fileId - The file version ID to download.
   * @param options - Optional method, range, SSE-C decryption, response-header overrides, and abort signal.
   *
   * @returns The download result with response headers and body stream.
   */
  async downloadById(fileId: FileId, options?: DownloadCallOptions): Promise<DownloadResult> {
    return downloadById(this.client.raw, this.client.accountInfo, {
      fileId,
      ...options,
    })
  }

  /**
   * Fetches response headers for a specific version of this file by ID
   * via HTTP HEAD. Returns a body-less result so callers never have to
   * drain the (logically empty) HEAD body themselves.
   *
   * @param fileId - The file version ID to inspect.
   * @param options - Optional range, SSE-C decryption, response-header
   *   overrides, and abort signal.
   *
   * @returns Parsed download headers.
   */
  async headById(fileId: FileId, options?: HeadCallOptions): Promise<HeadResult> {
    return headById(this.client.raw, this.client.accountInfo, {
      fileId,
      ...options,
    })
  }

  /**
   * Creates a parallel-download ReadableStream that fetches the file in concurrent ranged chunks.
   * @param fileId - The file version ID to download.
   * @param totalSize - Total file size in bytes (needed to compute range boundaries).
   * @param options - Concurrency, range size, and abort signal.
   *
   * @returns A Web ReadableStream of file data in sequential order.
   */
  createReadStream(
    fileId: FileId,
    totalSize: number,
    options?: {
      /** Size of each ranged GET request in bytes. Defaults to 8 MB. */
      rangeSize?: number
      /** Number of concurrent range requests. Defaults to 4. */
      concurrency?: number
      /** Abort signal for cancelling the download. */
      signal?: AbortSignal
    },
  ): ReadableStream<Uint8Array> {
    return createParallelDownloadStream(this.client.raw, this.client.accountInfo, {
      fileId,
      totalSize,
      ...options,
    })
  }

  /**
   * Creates a Web `WritableStream` that uploads streamed data into this file
   * using the multipart protocol. Pipe a `ReadableStream<Uint8Array>` into the
   * returned `writable` and await `done` to get the final {@link FileVersion}.
   *
   * Note: streaming uploads do not support resume because the size and per-part
   * hashes are not known in advance. Use {@link upload} with a buffered source
   * when resume is required.
   *
   * @param options - Streaming upload parameters (part size, concurrency, encryption).
   *
   * @returns A handle with the writable sink and a completion promise.
   */
  createWriteStream(options?: {
    /** MIME type. Defaults to `b2/x-auto`. */
    contentType?: string
    /** Custom key-value metadata stored with the file. */
    fileInfo?: Record<string, string>
    /** Server-side encryption applied to each part. */
    serverSideEncryption?: EncryptionSetting
    /** Target part size in bytes. Defaults to the account's recommended part size. */
    partSize?: number
    /** Maximum number of parts uploaded in parallel. Defaults to 4. */
    concurrency?: number
    /** Callback invoked with upload progress events. */
    onProgress?: ProgressListener
    /** Callback invoked before retrying with a fresh upload URL. */
    onUploadRetry?: UploadRetryListener
    /**
     * Retry when an upload response body cannot be read after B2 may have stored
     * the part. Defaults to true; set false to avoid re-sending the part.
     */
    retryResponseBodyFailures?: boolean
    /** Abort signal that cancels the upload and the unfinished large file. */
    signal?: AbortSignal
  }): UploadWriteHandle {
    return createWriteStream(this.client.raw, this.client.accountInfo, {
      ...(options ?? {}),
      bucketId: this.bucket.id,
      fileName: this.fileName,
      retry: this.uploadRetryOptions,
    })
  }

  /**
   * Retrieves metadata for a specific file version.
   * @param fileId - The file version ID to look up.
   *
   * @returns The file version metadata.
   */
  async getFileInfo(fileId: FileId): Promise<FileVersion> {
    return this.client.raw.getFileInfo(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileId },
    )
  }

  /**
   * Hides this file by creating a hide marker at this file name.
   *
   * @returns Metadata for the newly created hide marker.
   */
  async hide(): Promise<FileVersion> {
    return this.bucket.hideFile(this.fileName)
  }

  /**
   * Permanently deletes a specific version of this file.
   * @param fileId - The unique identifier of the file version to delete.
   */
  async deleteVersion(fileId: FileId): Promise<void> {
    await this.bucket.deleteFileVersion(this.fileName, fileId)
  }

  /**
   * Sets or updates the Object Lock retention policy on a specific file
   * version of this file.
   *
   * The bucket must have Object Lock enabled (`fileLockEnabled: true` at
   * creation time). Governance-mode retention can be shortened or removed
   * by passing `bypassGovernance: true` together with an application key
   * that carries the `bypassGovernance` capability; compliance-mode
   * retention cannot be shortened by anyone until the
   * `retainUntilTimestamp` elapses.
   *
   * @param fileId - The file version to apply the policy to.
   * @param retention - The retention policy to apply.
   * @param options - Optional flag for shortening governance-mode retention.
   *
   * @returns Metadata for the updated file version.
   */
  async setRetention(
    fileId: FileId,
    retention: FileRetentionValue,
    options?: { bypassGovernance?: boolean },
  ) {
    return this.bucket.updateFileRetention(this.fileName, fileId, retention, options)
  }

  /**
   * Toggles the legal hold flag on a specific file version of this file.
   *
   * Legal hold is independent of retention: a file can be on legal hold
   * without any retention policy, and vice versa. The bucket must have
   * Object Lock enabled, and any caller must hold the `writeFileLegalHolds`
   * capability.
   *
   * @param fileId - The file version to apply the flag to.
   * @param legalHold - `'on'` to apply the hold, `'off'` to remove it.
   *
   * @returns Metadata for the updated file version.
   */
  async setLegalHold(fileId: FileId, legalHold: LegalHoldValue) {
    return this.bucket.updateFileLegalHold(this.fileName, fileId, legalHold)
  }
}
