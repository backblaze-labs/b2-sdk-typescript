import type { B2Client } from './client.js'
import { type DownloadResult, downloadByName } from './download/single.js'
import { B2Object } from './object.js'
import type { ProgressListener } from './streams/progress.js'
import type { ContentSource } from './streams/source.js'
import type {
  BucketInfo,
  BucketRetentionPolicy,
  BucketType,
  CorsRule,
  LifecycleRule,
} from './types/bucket.js'
import type { DownloadAuthorizationResponse } from './types/download.js'
import type { EncryptionSetting } from './types/encryption.js'
import type {
  FileVersion,
  ListFileNamesResponse,
  ListFileVersionsResponse,
  MetadataDirective,
} from './types/file.js'
import type { BucketId, FileId } from './types/ids.js'
import { accountId } from './types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.js'
import type {
  EventNotificationRule,
  GetBucketNotificationRulesResponse,
} from './types/notifications.js'
import type { ReplicationConfiguration } from './types/replication.js'
import { uploadLargeFile } from './upload/large.js'
import { uploadSmallFile } from './upload/single.js'

/**
 * Handle to a B2 bucket providing upload, download, listing, and management operations.
 *
 * Obtained via {@link B2Client.createBucket}, {@link B2Client.listBuckets}, or {@link B2Client.getBucket}.
 *
 * @example
 * ```ts
 * const bucket = await client.getBucket('my-bucket')
 * await bucket.upload({ fileName: 'hello.txt', source: new BufferSource(data) })
 * ```
 */
export class Bucket {
  /** Unique identifier for this bucket. */
  readonly id: BucketId
  /** Human-readable bucket name. */
  readonly name: string
  /** Full bucket metadata as returned by the B2 API. */
  readonly info: BucketInfo
  private readonly client: B2Client

  /** @internal */
  constructor(client: B2Client, info: BucketInfo) {
    this.client = client
    this.info = info
    this.id = info.bucketId
    this.name = info.bucketName
  }

  /** Returns a {@link B2Object} handle for a specific file name in this bucket. */
  file(fileName: string): B2Object {
    return new B2Object(this.client, this, fileName)
  }

  /**
   * Uploads a file to this bucket. Automatically uses multipart upload for files
   * larger than the recommended part size.
   * @param options - Upload configuration including file name, source data, and optional settings.
   *
   * @returns Metadata for the uploaded file version.
   */
  async upload(options: {
    /** Destination file name (path) in the bucket. */
    fileName: string
    /** Data source to upload. Use {@link BufferSource}, {@link BlobSource}, or {@link StreamSource}. */
    source: ContentSource
    /** MIME type. Defaults to `"b2/x-auto"` (auto-detected by B2). */
    contentType?: string
    /** Custom key-value metadata stored with the file. */
    fileInfo?: Record<string, string>
    /** Server-side encryption settings. */
    serverSideEncryption?: EncryptionSetting
    /** File retention policy (requires file lock on the bucket). */
    fileRetention?: FileRetentionValue
    /** Legal hold status for the file. */
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

    if (isLarge) {
      return uploadLargeFile(this.client.raw, this.client.accountInfo, {
        bucketId: this.id,
        ...options,
      })
    }

    return uploadSmallFile(this.client.raw, this.client.accountInfo, {
      bucketId: this.id,
      ...options,
    })
  }

  /**
   * Downloads a file from this bucket by name.
   * @param fileName - The file name (path) to download.
   * @param options - Optional range and abort signal.
   *
   * @returns The download result containing response headers and a readable body stream.
   */
  async download(
    fileName: string,
    options?: {
      /** HTTP Range header value (e.g., `"bytes=0-999"`). */
      range?: string
      /** Abort signal for cancelling the download. */
      signal?: AbortSignal
    },
  ): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.name,
      fileName,
      ...options,
    })
  }

  /**
   * Lists file names in this bucket (most recent versions only).
   * @returns A page of file versions with an optional continuation token.
   */
  async listFileNames(options?: {
    /** Start listing after this file name (for pagination). */
    startFileName?: string
    /** Maximum number of files to return (1-10000). */
    maxFileCount?: number
    /** Only list files with names starting with this prefix. */
    prefix?: string
    /** Delimiter for virtual directory grouping (typically `"/"`). */
    delimiter?: string
  }): Promise<ListFileNamesResponse> {
    return this.client.raw.listFileNames(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.startFileName !== undefined ? { startFileName: options.startFileName } : {}),
        ...(options?.maxFileCount !== undefined ? { maxFileCount: options.maxFileCount } : {}),
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      },
    )
  }

  /**
   * Lists all file versions in this bucket, including hidden files.
   * @returns A page of file versions with an optional continuation token.
   */
  async listFileVersions(options?: {
    /** Start listing after this file name (for pagination). */
    startFileName?: string
    /** Start listing after this file ID (for pagination within a file name). */
    startFileId?: FileId
    /** Maximum number of file versions to return (1-10000). */
    maxFileCount?: number
    /** Only list files with names starting with this prefix. */
    prefix?: string
    /** Delimiter for virtual directory grouping. */
    delimiter?: string
  }): Promise<ListFileVersionsResponse> {
    return this.client.raw.listFileVersions(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, ...options },
    )
  }

  /**
   * Async generator that iterates over all files in the bucket, automatically handling pagination.
   * @param options - Optional prefix, delimiter, and page size.
   *
   * @returns An async generator of individual {@link FileVersion} objects.
   */
  async *listAllFiles(options?: {
    /** Only list files with names starting with this prefix. */
    prefix?: string
    /** Delimiter for virtual directory grouping. */
    delimiter?: string
    /** Number of files to fetch per API call (default 1000). */
    pageSize?: number
  }): AsyncGenerator<FileVersion> {
    let startFileName: string | undefined
    for (;;) {
      const resp = await this.listFileNames({
        ...(startFileName !== undefined ? { startFileName } : {}),
        maxFileCount: options?.pageSize ?? 1000,
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      })
      for (const file of resp.files) {
        yield file
      }
      if (!resp.nextFileName) break
      startFileName = resp.nextFileName
    }
  }

  /** Hides a file by creating a hide marker. The file remains in version history but is no longer visible in `listFileNames`. */
  async hideFile(fileName: string): Promise<FileVersion> {
    return this.client.raw.hideFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileName },
    )
  }

  /** Permanently deletes a specific file version. Both file name and file ID are required. */
  async deleteFileVersion(fileName: string, fileId: FileId): Promise<void> {
    await this.client.raw.deleteFileVersion(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId },
    )
  }

  /**
   * Creates a server-side copy of a file within or across buckets.
   * @param options - Copy configuration including source file ID and destination name.
   *
   * @returns Metadata for the newly created file version.
   */
  async copyFile(options: {
    /** File ID of the source file to copy. */
    sourceFileId: FileId
    /** Destination file name in the target bucket. */
    fileName: string
    /** Target bucket ID. Defaults to this bucket if omitted. */
    destinationBucketId?: BucketId
    /** Whether to copy or replace file metadata. */
    metadataDirective?: MetadataDirective
    /** Override content type (only with `REPLACE` metadata directive). */
    contentType?: string
    /** Override file info (only with `REPLACE` metadata directive). */
    fileInfo?: Record<string, string>
    /** Server-side encryption for the destination file. */
    serverSideEncryption?: EncryptionSetting
  }): Promise<FileVersion> {
    return this.client.raw.copyFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      options,
    )
  }

  /**
   * Updates bucket settings such as type, CORS, lifecycle rules, and encryption.
   * @param options - Fields to update. Omitted fields are left unchanged.
   *
   * @returns Updated bucket metadata.
   */
  async update(options: {
    /** Change the bucket access level. */
    bucketType?: BucketType
    /** Replace custom bucket metadata. */
    bucketInfo?: Record<string, string>
    /** Replace CORS rules. */
    corsRules?: CorsRule[]
    /** Change default server-side encryption. */
    defaultServerSideEncryption?: EncryptionSetting
    /** Change default file retention policy. */
    defaultRetention?: BucketRetentionPolicy
    /** Replace lifecycle rules. */
    lifecycleRules?: LifecycleRule[]
    /** Update replication configuration. */
    replicationConfiguration?: ReplicationConfiguration
    /** Optimistic locking: only update if the bucket revision matches. */
    ifRevisionIs?: number
  }): Promise<BucketInfo> {
    return this.client.raw.updateBucket(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        accountId: accountId(this.client.accountInfo.getAccountId()),
        bucketId: this.id,
        ...options,
      },
    )
  }

  /** Permanently deletes this bucket. The bucket must be empty (no file versions). */
  async delete(): Promise<BucketInfo> {
    return this.client.deleteBucket(this.id)
  }

  /**
   * Gets a download authorization token scoped to a file name prefix in this bucket.
   * @param fileNamePrefix - Only authorize downloads of files starting with this prefix.
   * @param validDurationInSeconds - How long the authorization is valid (1-604800 seconds).
   */
  async getDownloadAuthorization(
    fileNamePrefix: string,
    validDurationInSeconds: number,
  ): Promise<DownloadAuthorizationResponse> {
    return this.client.raw.getDownloadAuthorization(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileNamePrefix, validDurationInSeconds },
    )
  }

  /** Gets the event notification rules configured for this bucket. */
  async getNotificationRules(): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.getBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id },
    )
  }

  /** Replaces the event notification rules for this bucket. */
  async setNotificationRules(
    rules: EventNotificationRule[],
  ): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.setBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, eventNotificationRules: rules },
    )
  }

  /** Updates the file retention policy for a specific file version. Requires file lock on the bucket. */
  async updateFileRetention(fileName: string, fileId: FileId, retention: FileRetentionValue) {
    return this.client.raw.updateFileRetention(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId, fileRetention: retention },
    )
  }

  /** Updates the legal hold status for a specific file version. Requires file lock on the bucket. */
  async updateFileLegalHold(fileName: string, fileId: FileId, legalHold: LegalHoldValue) {
    return this.client.raw.updateFileLegalHold(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId, legalHold },
    )
  }
}
