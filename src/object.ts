import type { Bucket } from './bucket.js'
import type { B2Client } from './client.js'
import { createParallelDownloadStream } from './download/parallel.js'
import { type DownloadResult, downloadByName } from './download/single.js'
import { downloadById } from './download/single.js'
import type { ProgressListener } from './streams/progress.js'
import type { ContentSource } from './streams/source.js'
import type { EncryptionSetting } from './types/encryption.js'
import type { FileVersion } from './types/file.js'
import type { FileId } from './types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.js'
import { uploadLargeFile } from './upload/large.js'
import { uploadSmallFile } from './upload/single.js'

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

  /** @internal */
  constructor(client: B2Client, bucket: Bucket, fileName: string) {
    this.client = client
    this.bucket = bucket
    this.fileName = fileName
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
    /** Abort signal for cancelling the upload. */
    signal?: AbortSignal
  }): Promise<FileVersion> {
    const recommendedPartSize = this.client.accountInfo.getRecommendedPartSize()
    const isLarge = options.source.size > recommendedPartSize

    const baseOpts = {
      bucketId: this.bucket.id,
      fileName: this.fileName,
      ...options,
    }

    return isLarge
      ? uploadLargeFile(this.client.raw, this.client.accountInfo, baseOpts)
      : uploadSmallFile(this.client.raw, this.client.accountInfo, baseOpts)
  }

  /**
   * Downloads this file by name.
   * @param options - Optional range and abort signal.
   *
   * @returns The download result with response headers and body stream.
   */
  async download(options?: {
    /** HTTP Range header value (e.g., `"bytes=0-999"`). */
    range?: string
    /** Abort signal for cancelling the download. */
    signal?: AbortSignal
  }): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.bucket.name,
      fileName: this.fileName,
      ...options,
    })
  }

  /**
   * Downloads a specific version of this file by ID.
   * @param fileId - The file version ID to download.
   * @param options - Optional range and abort signal.
   */
  async downloadById(
    fileId: FileId,
    options?: {
      /** HTTP Range header value (e.g., `"bytes=0-999"`). */
      range?: string
      /** Abort signal for cancelling the download. */
      signal?: AbortSignal
    },
  ): Promise<DownloadResult> {
    return downloadById(this.client.raw, this.client.accountInfo, {
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
   * Retrieves metadata for a specific file version.
   * @param fileId - The file version ID to look up.
   */
  async getFileInfo(fileId: FileId): Promise<FileVersion> {
    return this.client.raw.getFileInfo(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileId },
    )
  }

  /** Hides this file by creating a hide marker at this file name. */
  async hide(): Promise<FileVersion> {
    return this.bucket.hideFile(this.fileName)
  }

  /** Permanently deletes a specific version of this file. */
  async deleteVersion(fileId: FileId): Promise<void> {
    await this.bucket.deleteFileVersion(this.fileName, fileId)
  }
}
