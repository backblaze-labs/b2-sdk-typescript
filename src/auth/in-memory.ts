import type { AuthorizeAccountResponse } from '../types/auth.js'
import type { BucketId } from '../types/ids.js'
import type { AccountInfo, UploadUrlEntry } from './account-info.js'
import { UploadUrlPool } from './upload-url-pool.js'

/**
 * In-memory implementation of {@link AccountInfo}.
 * Stores the authorization response and upload URL pools in plain object fields.
 * Suitable for short-lived processes or tests; state is lost when the process exits.
 */
export class InMemoryAccountInfo implements AccountInfo {
  /** Cached authorization response, or null before authorize() is called. */
  private auth: AuthorizeAccountResponse | null = null
  /** Pool of reusable small-file upload URLs, keyed by bucket ID. */
  private readonly uploadUrls = new UploadUrlPool()
  /** Pool of reusable large-file part upload URLs, keyed by file ID. */
  private readonly partUploadUrls = new UploadUrlPool()

  /**
   * Store a fresh authorization response, replacing any previous state.
   *
   * @param auth - The authorize account response to store.
   */
  setAuth(auth: AuthorizeAccountResponse): void {
    this.auth = auth
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  /**
   * Return the current authorization response, or null if not authorized.
   *
   * @returns The cached authorization response, or null if not yet authorized.
   */
  getAuth(): AuthorizeAccountResponse | null {
    return this.auth
  }

  /** Discard all cached authorization state and upload URLs. */
  clear(): void {
    this.auth = null
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  /**
   * Base URL for B2 API calls.
   *
   * @returns The base URL for B2 API calls.
   *
   * @throws Error if not yet authorized.
   */
  getApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.apiUrl
  }

  /**
   * Base URL for file downloads.
   *
   * @returns The base URL for file downloads.
   *
   * @throws Error if not yet authorized.
   */
  getDownloadUrl(): string {
    return this.requireAuth().apiInfo.storageApi.downloadUrl
  }

  /**
   * Current authorization token.
   *
   * @returns The current authorization token.
   *
   * @throws Error if not yet authorized.
   */
  getAuthToken(): string {
    return this.requireAuth().authorizationToken as string
  }

  /**
   * The authorized account ID.
   *
   * @returns The authorized account identifier.
   *
   * @throws Error if not yet authorized.
   */
  getAccountId(): string {
    return this.requireAuth().accountId as string
  }

  /**
   * Server-recommended part size for large file uploads, in bytes.
   *
   * @returns The server-recommended part size in bytes.
   *
   * @throws Error if not yet authorized.
   */
  getRecommendedPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.recommendedPartSize
  }

  /**
   * Smallest allowed part size for large file uploads, in bytes.
   *
   * @returns The smallest allowed part size in bytes.
   *
   * @throws Error if not yet authorized.
   */
  getAbsoluteMinimumPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.absoluteMinimumPartSize
  }

  /**
   * Base URL for the S3-compatible API.
   *
   * @returns The base URL for the S3-compatible API.
   *
   * @throws Error if not yet authorized.
   */
  getS3ApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.s3ApiUrl
  }

  /**
   * Bucket ID the key is restricted to, or null if unrestricted.
   *
   * @returns The restricted bucket identifier, or null if the key is unrestricted.
   *
   * @throws Error if not yet authorized.
   */
  getAllowedBucketId(): BucketId | null {
    return this.requireAuth().apiInfo.storageApi.allowed.bucketId ?? null
  }

  /**
   * Take an upload URL from the pool for the given bucket, or null if none available.
   *
   * @param bucketId - The bucket to check out an upload URL for.
   *
   * @returns A reusable upload URL entry, or null if none are available.
   */
  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null {
    return this.uploadUrls.checkout(bucketId as string)
  }

  /**
   * Return a still-valid upload URL to the pool for reuse.
   *
   * @param bucketId - The bucket the upload URL belongs to.
   * @param entry - The upload URL entry to return to the pool.
   */
  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.checkin(bucketId as string, entry)
  }

  /**
   * Remove an upload URL from the pool after an upload error.
   *
   * @param bucketId - The bucket the failed upload URL belongs to.
   * @param entry - The upload URL entry to remove from the pool.
   */
  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.evict(bucketId as string, entry)
  }

  /**
   * Take a large-file part upload URL from the pool, or null if none available.
   *
   * @param fileId - The large file to check out a part upload URL for.
   *
   * @returns A reusable part upload URL entry, or null if none are available.
   */
  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null {
    return this.partUploadUrls.checkout(fileId)
  }

  /**
   * Return a still-valid part upload URL to the pool for reuse.
   *
   * @param fileId - The large file the part upload URL belongs to.
   * @param entry - The part upload URL entry to return to the pool.
   */
  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.checkin(fileId, entry)
  }

  /**
   * Remove a part upload URL from the pool after an error.
   *
   * @param fileId - The large file the failed part upload URL belongs to.
   * @param entry - The part upload URL entry to remove from the pool.
   */
  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.evict(fileId, entry)
  }

  /**
   * Retrieve the cached auth response or throw if not yet authorized.
   *
   * @returns The cached authorization response.
   *
   * @throws Error if authorize() has not been called.
   */
  private requireAuth(): AuthorizeAccountResponse {
    if (!this.auth) throw new Error('Not authorized. Call authorize() first.')
    return this.auth
  }
}
