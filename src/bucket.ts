import type { B2Client } from './client.ts'
import { copyLargeFile } from './copy/large.ts'
import {
  type DownloadResult,
  downloadByName,
  type HeadResult,
  headByName,
} from './download/single.ts'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from './http/retry.ts'
import { B2Object, type DownloadCallOptions, type HeadCallOptions } from './object.ts'
import type {
  BucketInfo,
  BucketRetentionPolicy,
  BucketType,
  CorsRule,
  LifecycleRule,
} from './types/bucket.ts'
import type { DownloadAuthorizationResponse } from './types/download.ts'
import type { EncryptionSetting } from './types/encryption.ts'
import type {
  FileVersion,
  ListFileNamesResponse,
  ListFileVersionsResponse,
  MetadataDirective,
} from './types/file.ts'
import type { ApplicationKeyId, BucketId, FileId, LargeFileId } from './types/ids.ts'
import { accountId } from './types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.ts'
import type {
  EventNotificationRule,
  GetBucketNotificationRulesResponse,
} from './types/notifications.ts'
import type { ReplicationConfiguration, ReplicationRule } from './types/replication.ts'
import type { CancelLargeFileResponse, PartInfo, UnfinishedLargeFile } from './types/upload.ts'
import { Semaphore } from './upload/concurrency.ts'
import { uploadLargeFile } from './upload/large.ts'
import {
  type BucketUploadOptions,
  rejectSmallResumeFileId,
  stripResumeOnlyOptions,
} from './upload/options.ts'
import { uploadSmallFile } from './upload/single.ts'
import { DEFAULT_BULK_CONCURRENCY, DEFAULT_PAGE_SIZE } from './util/defaults.ts'
import { type PaginatorOptions, paginateItems } from './util/paginator.ts'
import { toError } from './util/to-error.ts'

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

interface BucketDefaultRetentionSnapshot {
  readonly retention?: BucketRetentionPolicy
  readonly unreadable: boolean
}

function bucketDefaultRetentionSnapshot(info: BucketInfo): BucketDefaultRetentionSnapshot {
  const fileLock = info.fileLockConfiguration
  if (!fileLock.isClientAuthorizedToRead) return { unreadable: true }
  if (fileLock.value === null) return { unreadable: false }
  return { retention: fileLock.value.defaultRetention, unreadable: false }
}

function resumeNeedsFreshBucketDefaults(options: BucketUploadOptions): boolean {
  const resumeRequested = options.resume === true || options.resumeFileId !== undefined
  return (
    resumeRequested &&
    (options.serverSideEncryption === undefined || options.fileRetention === undefined)
  )
}

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
  private readonly uploadRetryOptions: RetryOptions

  /**
   * @param client - The parent B2Client instance.
   * @param info - The bucket metadata from the API.
   * @param uploadRetryOptions - Resolved retry settings for upload-layer retries.
   *
   * @internal
   */
  constructor(
    client: B2Client,
    info: BucketInfo,
    uploadRetryOptions: RetryOptions = DEFAULT_RETRY_OPTIONS,
  ) {
    this.client = client
    this.info = info
    this.id = info.bucketId
    this.name = info.bucketName
    this.uploadRetryOptions = uploadRetryOptions
  }

  /**
   * Returns a {@link B2Object} handle for a specific file name in this bucket.
   * @param fileName - The file path within the bucket.
   *
   * @returns A B2Object handle bound to this bucket and file name.
   */
  file(fileName: string): B2Object {
    return new B2Object(this.client, this, fileName, this.uploadRetryOptions)
  }

  /**
   * Uploads a file to this bucket. Automatically uses multipart upload for files
   * larger than the recommended part size.
   * @param options - Upload configuration including file name, source data, and optional settings.
   *
   * @returns Metadata for the uploaded file version.
   */
  async upload(options: BucketUploadOptions): Promise<FileVersion> {
    const recommendedPartSize = this.client.accountInfo.getRecommendedPartSize()
    const isLarge = options.source.size > recommendedPartSize

    if (isLarge) {
      const bucketInfo = resumeNeedsFreshBucketDefaults(options) ? await this.refresh() : this.info
      const bucketDefaultRetention = bucketDefaultRetentionSnapshot(bucketInfo)
      return uploadLargeFile(this.client.raw, this.client.accountInfo, {
        ...options,
        bucketId: this.id,
        retry: this.uploadRetryOptions,
        bucketDefaultServerSideEncryption: bucketInfo.defaultServerSideEncryption,
        ...(bucketDefaultRetention.retention !== undefined
          ? { bucketDefaultRetention: bucketDefaultRetention.retention }
          : {}),
        ...(bucketDefaultRetention.unreadable ? { bucketDefaultRetentionUnreadable: true } : {}),
      })
    }
    rejectSmallResumeFileId(options, 'Bucket.upload')
    const smallOptions = stripResumeOnlyOptions(options)
    return uploadSmallFile(this.client.raw, this.client.accountInfo, {
      ...smallOptions,
      bucketId: this.id,
      retry: this.uploadRetryOptions,
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
   * Fetches the response headers (file metadata) for a file via HTTP
   * HEAD. Returns a body-less result so callers never have to drain
   * the (logically empty) HEAD body themselves.
   *
   * Use this for metadata-only checks like "does this file exist", "what
   * is its current SHA-1", "what is its Content-Length". For full file
   * retrieval use {@link Bucket.download}.
   *
   * @param fileName - The file name (path) to inspect.
   * @param options - Optional range, SSE-C decryption, response-header
   *   overrides, and abort signal. Same shape as {@link Bucket.download}'s
   *   options minus `method` (always HEAD) and `onProgress` (no body).
   *
   * @returns Parsed download headers (content type, SHA-1, file info, etc.).
   *
   * @example
   * ```ts
   * const { headers } = await bucket.head('photos/2026/sunset.jpg')
   * console.log(headers.contentLength, headers.contentSha1)
   * ```
   */
  async head(fileName: string, options?: HeadCallOptions): Promise<HeadResult> {
    return headByName(this.client.raw, this.client.accountInfo, {
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
    /**
     * Maximum number of files to return per request (1-10000).
     * Forwarded to the raw API's `maxFileCount` parameter.
     */
    pageSize?: number
    /** Only list files with names starting with this prefix. */
    prefix?: string
    /** Delimiter for virtual directory grouping (typically `"/"`). */
    delimiter?: string
    /** Optional abort signal for the listing request. */
    signal?: AbortSignal
  }): Promise<ListFileNamesResponse> {
    return this.client.raw.listFileNames(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.startFileName !== undefined ? { startFileName: options.startFileName } : {}),
        ...(options?.pageSize !== undefined ? { maxFileCount: options.pageSize } : {}),
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      },
      {
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
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
    /**
     * Maximum number of file versions to return per request (1-10000).
     * Forwarded to the raw API's `maxFileCount` parameter.
     */
    pageSize?: number
    /** Only list files with names starting with this prefix. */
    prefix?: string
    /** Delimiter for virtual directory grouping. */
    delimiter?: string
    /** Optional abort signal for the listing request. */
    signal?: AbortSignal
  }): Promise<ListFileVersionsResponse> {
    return this.client.raw.listFileVersions(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.startFileName !== undefined ? { startFileName: options.startFileName } : {}),
        ...(options?.startFileId !== undefined ? { startFileId: options.startFileId } : {}),
        ...(options?.pageSize !== undefined ? { maxFileCount: options.pageSize } : {}),
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      },
      {
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      },
    )
  }

  /**
   * Async iterator that yields the latest visible version of every file in
   * the bucket, automatically handling pagination via `listFileNames`.
   *
   * Hidden files (those whose latest version is a hide marker) are NOT
   * yielded by this iterator. Use {@link paginateFileVersions} when you
   * need full version history.
   *
   * @param options - Filter + pagination + abort options. `pageSize` is
   *   forwarded to `b2_list_file_names`'s `maxFileCount` (default 1000,
   *   B2-capped at 10000).
   *
   * @returns An async iterable of {@link FileVersion} entries.
   *
   * @example
   * ```ts
   * for await (const file of bucket.paginateFileNames({ prefix: 'photos/' })) {
   *   console.log(file.fileName, file.contentLength)
   * }
   * ```
   */
  paginateFileNames(
    options?: {
      /** Only yield files whose names start with this prefix. */
      prefix?: string
      /** Delimiter for virtual directory grouping (typically `'/'`). */
      delimiter?: string
    } & PaginatorOptions,
  ): AsyncIterableIterator<FileVersion> {
    return paginateItems(
      async (cursor: string | undefined) => {
        const resp = await this.listFileNames({
          pageSize: options?.pageSize ?? DEFAULT_PAGE_SIZE,
          ...(cursor !== undefined ? { startFileName: cursor } : {}),
          ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
          ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        })
        return { page: resp, nextCursor: resp.nextFileName ?? undefined }
      },
      // Real B2 surfaces hide markers as rows in `b2_list_file_names`. This
      // iterator's documented contract is "latest VISIBLE version", so we
      // drop hide-action rows here. Callers who need full history should
      // use `paginateFileVersions`.
      (page) => page.files.filter((f) => f.action !== 'hide'),
      options?.signal,
    )
  }

  /**
   * Async iterator that yields every version of every file in the bucket,
   * including hidden files and historical versions, automatically handling
   * pagination via `listFileVersions`.
   *
   * The two-cursor `(nextFileName, nextFileId)` continuation that the raw
   * endpoint exposes is threaded internally; callers iterate flat.
   *
   * @param options - Filter + pagination + abort options.
   *
   * @returns An async iterable of {@link FileVersion} entries.
   */
  paginateFileVersions(
    options?: {
      /** Only yield versions whose names start with this prefix. */
      prefix?: string
      /** Delimiter for virtual directory grouping. */
      delimiter?: string
    } & PaginatorOptions,
  ): AsyncIterableIterator<FileVersion> {
    type Cursor = { fileName: string; fileId: FileId | undefined }
    return paginateItems(
      async (cursor: Cursor | undefined) => {
        const resp = await this.listFileVersions({
          pageSize: options?.pageSize ?? DEFAULT_PAGE_SIZE,
          ...(cursor !== undefined ? { startFileName: cursor.fileName } : {}),
          ...(cursor?.fileId !== undefined ? { startFileId: cursor.fileId } : {}),
          ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
          ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        })
        const nextCursor: Cursor | undefined =
          resp.nextFileName !== null
            ? { fileName: resp.nextFileName, fileId: resp.nextFileId ?? undefined }
            : undefined
        return { page: resp, nextCursor }
      },
      (page) => page.files,
      options?.signal,
    )
  }

  /**
   * Async iterator that yields every unfinished large file in the bucket,
   * automatically handling pagination via `listUnfinishedLargeFiles`.
   *
   * Useful for janitorial scripts that want to inspect or cancel abandoned
   * multipart uploads (typically followed by {@link cancelLargeFile} on
   * the underlying raw client).
   *
   * @param options - Filter + pagination + abort options. `pageSize` is
   *   B2-capped at 100 for this endpoint.
   *
   * @returns An async iterable of unfinished-large-file metadata entries.
   */
  paginateUnfinishedLargeFiles(
    options?: {
      /** Only yield large files whose names start with this prefix. */
      namePrefix?: string
    } & PaginatorOptions,
  ): AsyncIterableIterator<UnfinishedLargeFile> {
    return paginateItems(
      async (cursor: LargeFileId | undefined) => {
        const resp = await this.listUnfinishedLargeFiles({
          pageSize: options?.pageSize ?? 100,
          ...(cursor !== undefined ? { startFileId: cursor } : {}),
          ...(options?.namePrefix !== undefined ? { namePrefix: options.namePrefix } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        })
        return { page: resp, nextCursor: resp.nextFileId ?? undefined }
      },
      (page) => page.files,
      options?.signal,
    )
  }

  /**
   * Async iterator that yields every uploaded part for a specific large
   * file, automatically handling pagination via `listParts`.
   *
   * @param largeFileId - The unfinished large file to enumerate parts of.
   * @param options - Pagination + abort options. `pageSize` is B2-capped
   *   at 1000 for this endpoint; the default is 1000.
   *
   * @returns An async iterable of {@link PartInfo} entries.
   */
  paginateParts(
    largeFileId: LargeFileId,
    options?: PaginatorOptions,
  ): AsyncIterableIterator<PartInfo> {
    return paginateItems(
      async (cursor: number | undefined) => {
        const resp = await this.client.raw.listParts(
          this.client.accountInfo.getApiUrl(),
          this.client.accountInfo.getAuthToken(),
          {
            fileId: largeFileId,
            maxPartCount: options?.pageSize ?? DEFAULT_PAGE_SIZE,
            ...(cursor !== undefined ? { startPartNumber: cursor } : {}),
          },
          options?.signal !== undefined ? { signal: options.signal } : undefined,
        )
        return { page: resp, nextCursor: resp.nextPartNumber ?? undefined }
      },
      (page) => page.parts,
      options?.signal,
    )
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
    // `listFileNames` returns the most recent version per file name,
    // which may be a hide marker (real B2: `action: 'hide'`,
    // `contentLength: 0`). This helper's contract is "latest LIVE
    // version", so we treat a hide-action match as "not found".
    const resp = await this.listFileNames({ prefix: fileName, pageSize: 1 })
    const match = resp.files.find((f) => f.fileName === fileName)
    if (!match || match.action === 'hide') return null
    return match
  }

  /**
   * Removes the latest hide marker for a file, restoring visibility of the
   * previous upload. Returns the deleted hide marker, or `null` if there was
   * no hide marker to remove (file is already visible or does not exist).
   * @param fileName - The file path to unhide.
   *
   * @returns The deleted hide marker version, or `null` if nothing was hidden.
   */
  async unhideFile(fileName: string): Promise<FileVersion | null> {
    // The latest version of a hidden file appears in listFileVersions but not
    // in listFileNames. Walk versions until we find the hide marker on top.
    const resp = await this.listFileVersions({ prefix: fileName, pageSize: 100 })
    const versions = resp.files.filter((f) => f.fileName === fileName)
    if (versions.length === 0) return null
    // listFileVersions sorts by name asc then upload timestamp desc, so the
    // first entry is the latest version.
    const latest = versions[0]
    if (latest?.action !== 'hide') return null
    await this.deleteFileVersion(fileName, latest.fileId)
    return latest
  }

  /**
   * Hides a file by creating a hide marker. The file remains in version history but is no longer visible in `listFileNames`.
   * @param fileName - The file path to hide.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns Metadata for the newly created hide marker.
   */
  async hideFile(fileName: string, options?: { signal?: AbortSignal }): Promise<FileVersion> {
    return this.client.raw.hideFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileName },
      options,
    )
  }

  /**
   * Permanently deletes a specific file version. Both file name and file ID are required.
   *
   * If the file is under Object Lock retention, B2 will reject the
   * delete: compliance-mode files cannot be deleted until the retention
   * expires; governance-mode files require `bypassGovernance: true`
   * AND a calling key with the `bypassGovernance` capability. Files on
   * legal hold cannot be deleted by anyone until the hold is removed.
   *
   * @param fileName - The file path of the version to delete.
   * @param fileId - The unique identifier of the file version to delete.
   * @param options - Optional governance and abort controls.
   */
  async deleteFileVersion(
    fileName: string,
    fileId: FileId,
    options?: { bypassGovernance?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    await this.client.raw.deleteFileVersion(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        fileName,
        fileId,
        ...(options?.bypassGovernance !== undefined
          ? { bypassGovernance: options.bypassGovernance }
          : {}),
      },
      options?.signal !== undefined ? { signal: options.signal } : undefined,
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
    /** Start listing at this file ID, inclusive (for pagination). */
    startFileId?: LargeFileId
    /**
     * Maximum number of files to return per request (1-100). Forwarded
     * to the raw API's `maxFileCount` parameter.
     */
    pageSize?: number
    /** Abort signal for cancelling the list request. */
    signal?: AbortSignal
  }) {
    return this.client.raw.listUnfinishedLargeFiles(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.namePrefix !== undefined ? { namePrefix: options.namePrefix } : {}),
        ...(options?.startFileId !== undefined ? { startFileId: options.startFileId } : {}),
        ...(options?.pageSize !== undefined ? { maxFileCount: options.pageSize } : {}),
      },
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Deletes many file versions with bounded concurrency. Errors from individual
   * deletes are collected and returned rather than thrown, so partial success
   * does not abort the run.
   *
   * When `options.signal` is supplied and aborted, in-flight deletes
   * complete (they're already on the wire), but no new deletes start
   * after the abort fires. Subsequent targets are short-circuited to an
   * error entry so the result tally reflects what actually happened.
   * @param targets - File versions to delete.
   * @param options - Optional concurrency override and abort signal.
   *   Concurrency defaults to the SDK-wide bulk-metadata setting
   *   (currently 10, higher than transfer concurrency because each
   *   task is a single tiny API round-trip).
   *
   * @returns A summary of successes and per-target errors.
   */
  async deleteMany(
    targets: readonly DeleteTarget[],
    options?: { concurrency?: number; signal?: AbortSignal },
  ): Promise<DeleteManyResult> {
    const concurrency = options?.concurrency ?? DEFAULT_BULK_CONCURRENCY
    const sem = new Semaphore(concurrency)
    const signal = options?.signal
    let deleted = 0
    const errors: DeleteError[] = []

    await Promise.all(
      targets.map(async (target) => {
        await sem.acquire()
        try {
          // Honour abort BETWEEN acquisitions: in-flight deletes
          // complete (they're already on the wire), but new tasks don't
          // start once the signal fires. Without this gate, aborting a
          // 1000-item deleteMany would still let the next `concurrency`
          // tasks dispatch before the caller's await returned.
          if (signal?.aborted) {
            errors.push({
              target,
              error: toError(signal.reason ?? 'aborted'),
            })
            return
          }
          await this.deleteFileVersion(target.fileName, target.fileId)
          deleted++
        } catch (err) {
          errors.push({
            target,
            error: toError(err),
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
    const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE

    let startFileName: string | undefined
    let startFileId: FileId | undefined
    while (true) {
      const page = await this.listFileVersions({
        pageSize,
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
            message: toError(err).message,
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
    /**
     * @deprecated Renamed to `destinationServerSideEncryption` for consistency with
     * multipart copy. Still honored as a fallback when the new field is absent.
     */
    serverSideEncryption?: EncryptionSetting
    /** Server-side encryption for the destination file. Preferred over `serverSideEncryption`. */
    destinationServerSideEncryption?: EncryptionSetting
    /** SSE-C settings for the source if it was uploaded with SSE-C. */
    sourceServerSideEncryption?: EncryptionSetting
    /** Optional abort signal for cancelling the copy request. */
    signal?: AbortSignal
  }): Promise<FileVersion> {
    const { serverSideEncryption, destinationServerSideEncryption, signal, ...copyOptions } =
      options
    const destinationEncryption = destinationServerSideEncryption ?? serverSideEncryption
    return this.client.raw.copyFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        ...copyOptions,
        ...(destinationEncryption !== undefined
          ? { destinationServerSideEncryption: destinationEncryption }
          : {}),
      },
      signal !== undefined ? { signal } : undefined,
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
    /**
     * Maximum number of parts copied in parallel. Defaults to the
     * SDK-wide transfer concurrency.
     */
    concurrency?: number
    /**
     * Optional abort signal. Aborting cancels any remaining parts and
     * triggers a best-effort `cancelLargeFile` on the unfinished upload.
     */
    signal?: AbortSignal
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
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
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

  /**
   * Refetches this bucket's metadata from B2 so callers operating on
   * replication / lifecycle / retention configuration always start from the
   * server-of-record state.
   *
   * Bucket configuration is monotonically revisioned by B2: B2 increments
   * `revision` on every accepted update. The local {@link info} snapshot
   * captured at construction time goes stale as soon as anyone else (or any
   * prior `update()` call) mutates the bucket, so the ergonomic
   * add/remove helpers below always refresh before composing the next
   * `setX()` call. The result is that each helper is safe to call without
   * the caller having to thread BucketInfo through their code.
   *
   * @returns Fresh {@link BucketInfo} for this bucket.
   *
   * @throws If the bucket no longer exists.
   */
  private async refresh(): Promise<BucketInfo> {
    const fresh = await this.client.listBuckets({ bucketId: this.id })
    const found = fresh[0]
    if (!found) throw new Error(`Bucket ${this.id} not found`)
    return found.info
  }

  /**
   * Returns the current cross-region replication configuration, refetched
   * from B2.
   *
   * Use this when you need to read replication state without composing a
   * write. For add/remove flows the helper methods below handle the
   * refresh-then-set sequence for you.
   *
   * @returns The current {@link ReplicationConfiguration}.
   */
  async getReplication(): Promise<ReplicationConfiguration> {
    const fresh = await this.refresh()
    return fresh.replicationConfiguration
  }

  /**
   * Replaces this bucket's complete replication configuration.
   * @param replication - The new configuration. Pass an empty source/destination
   *   pair (`{ asReplicationSource: null, asReplicationDestination: null }`)
   *   to clear replication entirely.
   *
   * @returns The updated bucket metadata.
   */
  async setReplication(replication: ReplicationConfiguration): Promise<BucketInfo> {
    return this.update({ replicationConfiguration: replication })
  }

  /**
   * Adds (or replaces by `replicationRuleName`) a single replication rule
   * on this bucket while leaving any other rules, the source key, and the
   * destination key mapping untouched.
   *
   * When this is the very first source-side rule, `sourceApplicationKeyId`
   * must be supplied to seed `asReplicationSource.sourceApplicationKeyId`;
   * for subsequent calls the existing source key is reused unless the
   * caller explicitly overrides it.
   *
   * @param rule - The replication rule to add or replace.
   * @param options - Optional source application key ID override (or seed
   *   when no source side exists yet).
   *
   * @returns The updated bucket metadata.
   *
   * @throws If no source-side replication exists yet and the caller did
   *   not supply `sourceApplicationKeyId`.
   */
  async addReplicationRule(
    rule: ReplicationRule,
    options?: { sourceApplicationKeyId?: ApplicationKeyId },
  ): Promise<BucketInfo> {
    const current = (await this.refresh()).replicationConfiguration
    const existingSource = current.asReplicationSource
    const sourceKey = options?.sourceApplicationKeyId ?? existingSource?.sourceApplicationKeyId
    if (!sourceKey) {
      throw new Error(
        'addReplicationRule: no existing source-side replication; pass options.sourceApplicationKeyId',
      )
    }
    const existingRules = existingSource?.replicationRules ?? []
    const without = existingRules.filter((r) => r.replicationRuleName !== rule.replicationRuleName)
    return this.setReplication({
      asReplicationSource: {
        sourceApplicationKeyId: sourceKey,
        replicationRules: [...without, rule],
      },
      asReplicationDestination: current.asReplicationDestination,
    })
  }

  /**
   * Removes a single replication rule by name. No-ops cleanly when the rule
   * is not present (returns the unchanged-but-revision-bumped bucket info).
   *
   * @param replicationRuleName - Name of the rule to remove.
   *
   * @returns The updated bucket metadata.
   */
  async removeReplicationRule(replicationRuleName: string): Promise<BucketInfo> {
    const current = (await this.refresh()).replicationConfiguration
    const existingSource = current.asReplicationSource
    if (!existingSource) {
      return this.setReplication(current)
    }
    const filtered = existingSource.replicationRules.filter(
      (r) => r.replicationRuleName !== replicationRuleName,
    )
    return this.setReplication({
      asReplicationSource: {
        sourceApplicationKeyId: existingSource.sourceApplicationKeyId,
        replicationRules: filtered,
      },
      asReplicationDestination: current.asReplicationDestination,
    })
  }

  /**
   * Returns the current lifecycle rules for this bucket, refetched from B2.
   *
   * @returns The current array of {@link LifecycleRule}s.
   */
  async getLifecycleRules(): Promise<readonly LifecycleRule[]> {
    const fresh = await this.refresh()
    return fresh.lifecycleRules
  }

  /**
   * Replaces this bucket's lifecycle rules in their entirety.
   * @param rules - The new rule set. Pass `[]` to remove all lifecycle
   *   automation.
   *
   * @returns The updated bucket metadata.
   */
  async setLifecycleRules(rules: readonly LifecycleRule[]): Promise<BucketInfo> {
    return this.update({ lifecycleRules: [...rules] })
  }

  /**
   * Adds (or replaces, matched by `fileNamePrefix`) a single lifecycle rule
   * while leaving any other rules untouched.
   *
   * Matching on prefix mirrors B2's own data model: each unique prefix can
   * have at most one rule, and a `b2_update_bucket` call that contains two
   * rules with the same prefix is rejected. The helper enforces this for
   * the caller.
   *
   * @param rule - The lifecycle rule to add or replace.
   *
   * @returns The updated bucket metadata.
   */
  async addLifecycleRule(rule: LifecycleRule): Promise<BucketInfo> {
    const current = await this.getLifecycleRules()
    const without = current.filter((r) => r.fileNamePrefix !== rule.fileNamePrefix)
    return this.setLifecycleRules([...without, rule])
  }

  /**
   * Removes a single lifecycle rule by prefix. No-ops cleanly when the rule
   * is not present.
   *
   * @param fileNamePrefix - The prefix of the rule to remove.
   *
   * @returns The updated bucket metadata.
   */
  async removeLifecycleRule(fileNamePrefix: string): Promise<BucketInfo> {
    const current = await this.getLifecycleRules()
    return this.setLifecycleRules(current.filter((r) => r.fileNamePrefix !== fileNamePrefix))
  }

  /**
   * Returns the current default Object Lock retention policy for new
   * uploads to this bucket, refetched from B2.
   *
   * @returns The default {@link BucketRetentionPolicy} (which may be
   *   `{ mode: 'none', period: null }` when Object Lock is enabled on the
   *   bucket but no default is set).
   */
  async getDefaultRetention(): Promise<BucketRetentionPolicy> {
    const fresh = await this.refresh()
    return fresh.defaultRetention
  }

  /**
   * Sets (or clears, by passing `{ mode: 'none', period: null }`) the
   * default Object Lock retention policy applied to new uploads.
   *
   * Object Lock must already be enabled on the bucket. Buckets created
   * without `fileLockEnabled: true` cannot accept a default retention
   * policy and B2 will reject this call.
   *
   * @param policy - The new default retention policy.
   *
   * @returns The updated bucket metadata.
   */
  async setDefaultRetention(policy: BucketRetentionPolicy): Promise<BucketInfo> {
    return this.update({ defaultRetention: policy })
  }
}
