import type { B2Client } from './client.js'
import { copyLargeFile } from './copy/large.js'
import { type DownloadResult, downloadByName } from './download/single.js'
import { B2Object, type DownloadCallOptions } from './object.js'
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
import type { BucketId, FileId, LargeFileId } from './types/ids.js'
import { accountId } from './types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.js'
import type {
  EventNotificationRule,
  GetBucketNotificationRulesResponse,
} from './types/notifications.js'
import type { ReplicationConfiguration } from './types/replication.js'
import type { CancelLargeFileResponse } from './types/upload.js'
import { Semaphore } from './upload/concurrency.js'
import { uploadLargeFile } from './upload/large.js'
import { uploadSmallFile } from './upload/single.js'

/** A target for bulk deletion: a file name and its specific version ID. */
export interface DeleteTarget {
  /** File name (path) of the version to delete. */
  readonly fileName: string
  /** Unique identifier of the file version. */
  readonly fileId: FileId
}

/** Per-target error encountered during bulk deletion. */
export interface DeleteError {
  /** The target that failed. */
  readonly target: DeleteTarget
  /** The error thrown by the underlying `deleteFileVersion` call. */
  readonly error: Error
}

/** Aggregate result of a {@link Bucket.deleteMany} run. */
export interface DeleteManyResult {
  /** Number of file versions successfully deleted. */
  readonly deleted: number
  /** Per-target failures. Empty on full success. */
  readonly errors: readonly DeleteError[]
}

/** Emitted by {@link Bucket.deleteAll} once a file version has been successfully deleted. */
export interface DeleteAllDeleteEvent {
  /** Discriminant identifying a successful delete. */
  readonly type: 'delete'
  /** File name of the deleted version. */
  readonly fileName: string
  /** Unique identifier of the deleted version. */
  readonly fileId: FileId
}

/** Emitted by {@link Bucket.deleteAll} when a single delete call fails (other versions keep streaming). */
export interface DeleteAllErrorEvent {
  /** Discriminant identifying a per-version delete failure. */
  readonly type: 'error'
  /** File name of the version that failed to delete. */
  readonly fileName: string
  /** Unique identifier of the version that failed to delete. */
  readonly fileId: FileId
  /** Human-readable failure reason taken from the underlying error. */
  readonly message: string
}

/** Emitted by {@link Bucket.deleteAll} in `dryRun` mode for every version that would have been deleted. */
export interface DeleteAllSkipEvent {
  /** Discriminant identifying a dry-run skip. */
  readonly type: 'skip'
  /** File name of the version that would have been deleted. */
  readonly fileName: string
  /** Unique identifier of the version that would have been deleted. */
  readonly fileId: FileId
}

/** Event yielded by {@link Bucket.deleteAll} as it streams through file versions. */
export type DeleteAllEvent = DeleteAllDeleteEvent | DeleteAllErrorEvent | DeleteAllSkipEvent

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

  /**
   * @param client - The parent B2Client instance.
   * @param info - The bucket metadata from the API.
   *
   * @internal
   */
  constructor(client: B2Client, info: BucketInfo) {
    this.client = client
    this.info = info
    this.id = info.bucketId
    this.name = info.bucketName
  }

  /**
   * Returns a {@link B2Object} handle for a specific file name in this bucket.
   * @param fileName - The file path within the bucket.
   *
   * @returns A B2Object handle bound to this bucket and file name.
   */
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
   * Downloads a file from this bucket by name. Pass `method: 'HEAD'` in
   * `options` to fetch only the response headers (file metadata) without
   * streaming the body.
   * @param fileName - The file name (path) to download.
   * @param options - Optional method, range, SSE-C decryption, response-header overrides, and abort signal.
   *
   * @returns The download result containing response headers and a readable body stream.
   */
  async download(fileName: string, options?: DownloadCallOptions): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.name,
      fileName,
      ...options,
    })
  }

  /**
   * Lists file names in this bucket (most recent versions only).
   * @param options - Optional filtering and pagination settings.
   *
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
   * @param options - Optional filtering and pagination settings.
   *
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

  /**
   * Looks up the latest visible version of a file by name.
   * Uses `listFileNames` under the hood; returns `null` when the file does not
   * exist or its latest version is a hide marker.
   * @param fileName - The exact file path to look up.
   *
   * @returns The latest {@link FileVersion}, or `null` if not found.
   */
  async getFileInfoByName(fileName: string): Promise<FileVersion | null> {
    const resp = await this.listFileNames({ prefix: fileName, maxFileCount: 1 })
    const match = resp.files.find((f) => f.fileName === fileName)
    return match ?? null
  }

  /**
   * Removes the latest hide marker for a file, restoring visibility of the
   * previous upload. Returns the deleted hide marker, or `null` if there was
   * no hide marker to remove (file is already visible or does not exist).
   * @param fileName - The file path to unhide.
   *
   * @returns The deleted hide marker version, or `null` if nothing was hidden.
   */
  async unhide(fileName: string): Promise<FileVersion | null> {
    // The latest version of a hidden file appears in listFileVersions but not
    // in listFileNames. Walk versions until we find the hide marker on top.
    const resp = await this.listFileVersions({ prefix: fileName, maxFileCount: 100 })
    const versions = resp.files.filter((f) => f.fileName === fileName)
    if (versions.length === 0) return null
    // listFileVersions sorts by name asc then upload timestamp desc, so the
    // first entry is the latest version.
    const latest = versions[0]
    if (!latest || latest.action !== 'hide') return null
    await this.deleteFileVersion(fileName, latest.fileId)
    return latest
  }

  /**
   * Hides a file by creating a hide marker. The file remains in version history but is no longer visible in `listFileNames`.
   * @param fileName - The file path to hide.
   *
   * @returns Metadata for the newly created hide marker.
   */
  async hideFile(fileName: string): Promise<FileVersion> {
    return this.client.raw.hideFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileName },
    )
  }

  /**
   * Permanently deletes a specific file version. Both file name and file ID are required.
   * @param fileName - The file path of the version to delete.
   * @param fileId - The unique identifier of the file version to delete.
   */
  async deleteFileVersion(fileName: string, fileId: FileId): Promise<void> {
    await this.client.raw.deleteFileVersion(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId },
    )
  }

  /**
   * Cancels an in-progress large file upload so the partial parts are not
   * retained or billed. The most common reason to call this is to clean up
   * abandoned multipart uploads surfaced by {@link listUnfinishedLargeFiles}.
   * @param fileId - The unique identifier of the unfinished large file to cancel.
   *
   * @returns Metadata about the cancelled large file.
   */
  async cancelLargeFile(fileId: LargeFileId): Promise<CancelLargeFileResponse> {
    return this.client.raw.cancelLargeFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileId },
    )
  }

  /**
   * Lists large files in this bucket that were started but never finished or
   * cancelled. Wraps `b2_list_unfinished_large_files`.
   * @param options - Optional pagination filters.
   *
   * @returns The page of unfinished large files plus a continuation token.
   */
  async listUnfinishedLargeFiles(options?: {
    /** Restrict results to files whose name starts with this prefix. */
    namePrefix?: string
    /** Start listing after this file ID (for pagination). */
    startFileId?: LargeFileId
    /** Maximum number of files to return (1-100). */
    maxFileCount?: number
  }) {
    return this.client.raw.listUnfinishedLargeFiles(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.namePrefix !== undefined ? { namePrefix: options.namePrefix } : {}),
        ...(options?.startFileId !== undefined ? { startFileId: options.startFileId } : {}),
        ...(options?.maxFileCount !== undefined ? { maxFileCount: options.maxFileCount } : {}),
      },
    )
  }

  /**
   * Deletes many file versions with bounded concurrency. Errors from individual
   * deletes are collected and returned rather than thrown, so partial success
   * does not abort the run.
   * @param targets - File versions to delete.
   * @param options - Optional concurrency override (default 10).
   *
   * @returns A summary of successes and per-target errors.
   */
  async deleteMany(
    targets: readonly DeleteTarget[],
    options?: { concurrency?: number },
  ): Promise<DeleteManyResult> {
    const concurrency = options?.concurrency ?? 10
    const sem = new Semaphore(concurrency)
    let deleted = 0
    const errors: DeleteError[] = []

    await Promise.all(
      targets.map(async (target) => {
        await sem.acquire()
        try {
          await this.deleteFileVersion(target.fileName, target.fileId)
          deleted++
        } catch (err) {
          errors.push({
            target,
            error: err instanceof Error ? err : new Error(String(err)),
          })
        } finally {
          sem.release()
        }
      }),
    )

    return { deleted, errors }
  }

  /**
   * Async generator that streams every file version in the bucket (optionally
   * filtered by prefix) and deletes each one. Yields a {@link DeleteAllEvent}
   * per file version. With `dryRun: true`, no deletes are performed but `skip`
   * events are still emitted.
   * @param options - Optional prefix filter, page size, and dry-run flag.
   *
   * @returns An async generator of per-file events.
   */
  async *deleteAll(options?: {
    /** Only delete file versions whose names start with this prefix. */
    prefix?: string
    /** Number of file versions fetched per API page (default 1000). */
    pageSize?: number
    /** If true, yield `skip` events without actually deleting anything. */
    dryRun?: boolean
  }): AsyncGenerator<DeleteAllEvent> {
    const dryRun = options?.dryRun ?? false
    const pageSize = options?.pageSize ?? 1000

    let startFileName: string | undefined
    let startFileId: FileId | undefined
    for (;;) {
      const page = await this.listFileVersions({
        maxFileCount: pageSize,
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
        ...(startFileId !== undefined ? { startFileId } : {}),
      })

      for (const version of page.files) {
        if (dryRun) {
          yield { type: 'skip', fileName: version.fileName, fileId: version.fileId }
          continue
        }
        try {
          await this.deleteFileVersion(version.fileName, version.fileId)
          yield { type: 'delete', fileName: version.fileName, fileId: version.fileId }
        } catch (err) {
          yield {
            type: 'error',
            fileName: version.fileName,
            fileId: version.fileId,
            message: err instanceof Error ? err.message : String(err),
          }
        }
      }

      if (!page.nextFileName) break
      startFileName = page.nextFileName
      startFileId = page.nextFileId ?? undefined
    }
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
   * Copies a file via the server-side multipart protocol. Each part is copied
   * by reference through `b2_copy_part`; data never traverses the client. Falls
   * back to a single `copyFile` call when the source fits within a single part.
   * @param options - Copy parameters including source file ID, destination name, part size, and concurrency.
   *
   * @returns Metadata for the newly created destination file version.
   */
  async copyLargeFile(options: {
    /** File ID of the source file to copy. */
    sourceFileId: FileId
    /** Destination file name in the target bucket. */
    fileName: string
    /** Target bucket ID. Defaults to this bucket if omitted. */
    destinationBucketId?: BucketId
    /** Override content type for the destination. */
    contentType?: string
    /** Custom file info for the destination. */
    fileInfo?: Record<string, string>
    /** Server-side encryption for the destination file. */
    destinationServerSideEncryption?: EncryptionSetting
    /** SSE-C settings for the source if it was uploaded with SSE-C. */
    sourceServerSideEncryption?: EncryptionSetting
    /** Part size in bytes. Defaults to the account's recommended part size. */
    partSize?: number
    /** Maximum number of parts copied in parallel. Defaults to 4. */
    concurrency?: number
  }): Promise<FileVersion> {
    return copyLargeFile(this.client.raw, this.client.accountInfo, {
      sourceFileId: options.sourceFileId,
      fileName: options.fileName,
      ...(options.destinationBucketId !== undefined
        ? { destinationBucketId: options.destinationBucketId }
        : { destinationBucketId: this.id }),
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.fileInfo !== undefined ? { fileInfo: options.fileInfo } : {}),
      ...(options.destinationServerSideEncryption !== undefined
        ? { destinationServerSideEncryption: options.destinationServerSideEncryption }
        : {}),
      ...(options.sourceServerSideEncryption !== undefined
        ? { sourceServerSideEncryption: options.sourceServerSideEncryption }
        : {}),
      ...(options.partSize !== undefined ? { partSize: options.partSize } : {}),
      ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    })
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

  /**
   * Permanently deletes this bucket. The bucket must be empty (no file versions).
   *
   * @returns The deleted bucket metadata.
   */
  async delete(): Promise<BucketInfo> {
    return this.client.deleteBucket(this.id)
  }

  /**
   * Gets a download authorization token scoped to a file name prefix in this bucket.
   * @param fileNamePrefix - Only authorize downloads of files starting with this prefix.
   * @param validDurationInSeconds - How long the authorization is valid (1-604800 seconds).
   *
   * @returns The download authorization response containing a time-limited token.
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

  /**
   * Gets the event notification rules configured for this bucket.
   *
   * @returns The current notification rules for this bucket.
   */
  async getNotificationRules(): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.getBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id },
    )
  }

  /**
   * Replaces the event notification rules for this bucket.
   * @param rules - The new set of notification rules to apply.
   *
   * @returns The updated notification rules for this bucket.
   */
  async setNotificationRules(
    rules: EventNotificationRule[],
  ): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.setBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, eventNotificationRules: rules },
    )
  }

  /**
   * Updates the file retention policy for a specific file version. Requires file lock on the bucket.
   * @param fileName - The file path of the version to update.
   * @param fileId - The unique identifier of the file version.
   * @param retention - The new retention policy to apply.
   * @param options - Optional flags. Set `bypassGovernance: true` to shorten governance-mode retention.
   *
   * @returns The updated file retention metadata.
   */
  async updateFileRetention(
    fileName: string,
    fileId: FileId,
    retention: FileRetentionValue,
    options?: { bypassGovernance?: boolean },
  ) {
    return this.client.raw.updateFileRetention(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        fileName,
        fileId,
        fileRetention: retention,
        ...(options?.bypassGovernance !== undefined
          ? { bypassGovernance: options.bypassGovernance }
          : {}),
      },
    )
  }

  /**
   * Updates the legal hold status for a specific file version. Requires file lock on the bucket.
   * @param fileName - The file path of the version to update.
   * @param fileId - The unique identifier of the file version.
   * @param legalHold - The new legal hold status to apply.
   *
   * @returns The updated legal hold metadata.
   */
  async updateFileLegalHold(fileName: string, fileId: FileId, legalHold: LegalHoldValue) {
    return this.client.raw.updateFileLegalHold(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId, legalHold },
    )
  }
}
