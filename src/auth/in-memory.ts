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

  /** {@inheritDoc} */
  setAuth(auth: AuthorizeAccountResponse): void {
    this.auth = auth
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  /** {@inheritDoc} */
  getAuth(): AuthorizeAccountResponse | null {
    return this.auth
  }

  /** {@inheritDoc} */
  clear(): void {
    this.auth = null
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  /** {@inheritDoc} */
  getApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.apiUrl
  }

  /** {@inheritDoc} */
  getDownloadUrl(): string {
    return this.requireAuth().apiInfo.storageApi.downloadUrl
  }

  /** {@inheritDoc} */
  getAuthToken(): string {
    return this.requireAuth().authorizationToken as string
  }

  /** {@inheritDoc} */
  getAccountId(): string {
    return this.requireAuth().accountId as string
  }

  /** {@inheritDoc} */
  getRecommendedPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.recommendedPartSize
  }

  /** {@inheritDoc} */
  getAbsoluteMinimumPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.absoluteMinimumPartSize
  }

  /** {@inheritDoc} */
  getS3ApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.s3ApiUrl
  }

  /** {@inheritDoc} */
  getAllowedBucketId(): BucketId | null {
    return this.requireAuth().apiInfo.storageApi.allowed.bucketId ?? null
  }

  /** {@inheritDoc} */
  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null {
    return this.uploadUrls.checkout(bucketId as string)
  }

  /** {@inheritDoc} */
  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.checkin(bucketId as string, entry)
  }

  /** {@inheritDoc} */
  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.evict(bucketId as string, entry)
  }

  /** {@inheritDoc} */
  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null {
    return this.partUploadUrls.checkout(fileId)
  }

  /** {@inheritDoc} */
  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.checkin(fileId, entry)
  }

  /** {@inheritDoc} */
  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.evict(fileId, entry)
  }

  /** Retrieve the cached auth response or throw if not yet authorized. */
  private requireAuth(): AuthorizeAccountResponse {
    if (!this.auth) throw new Error('Not authorized. Call authorize() first.')
    return this.auth
  }
}
