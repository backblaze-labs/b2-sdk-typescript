import type { AuthorizeAccountResponse } from '../types/auth.ts'
import type { BucketId } from '../types/ids.ts'

/** A pre-authorized upload URL paired with its authorization token. */
export interface UploadUrlEntry {
  /** The URL to POST file data to. */
  readonly uploadUrl: string
  /** Authorization token to include with the upload request. */
  readonly authorizationToken: string
}

/**
 * Optional extension for persistent auth stores that need to bind cached auth
 * to the current client configuration. `B2Client` calls these hooks during
 * construction before it reuses any loaded auth.
 */
export interface AuthContextAwareAccountInfo {
  /**
   * Bind persistent auth caches to the resolved realm URL. Implementations that
   * persist auth should discard loaded state written for a different realm.
   */
  setRealmUrl(realmUrl: string): void
  /**
   * Bind persistent auth caches to the configured application key ID.
   * Implementations that persist auth should discard loaded state written for a
   * different key ID.
   */
  setApplicationKeyId(applicationKeyId: string): void
}

/**
 * Stores B2 authorization state between requests.
 * Implementations cache the authorize-account response and manage
 * pools of reusable upload URLs (checkout/checkin/evict pattern).
 */
export interface AccountInfo {
  /**
   * @deprecated Persistent auth stores should implement
   * {@link AuthContextAwareAccountInfo}. This optional hook remains for
   * source compatibility with older integrations.
   */
  setRealmUrl?(realmUrl: string): void
  /**
   * @deprecated Persistent auth stores should implement
   * {@link AuthContextAwareAccountInfo}. This optional hook remains for
   * source compatibility with older integrations.
   */
  setApplicationKeyId?(applicationKeyId: string): void

  /** Store a fresh authorization response, replacing any previous state. */
  setAuth(auth: AuthorizeAccountResponse): void
  /** Return the current authorization response, or null if not authorized. */
  getAuth(): AuthorizeAccountResponse | null
  /** Discard all cached authorization state and upload URLs. */
  clear(): void

  /** Base URL for B2 API calls. */
  getApiUrl(): string
  /** Base URL for file downloads. */
  getDownloadUrl(): string
  /** Current authorization token. */
  getAuthToken(): string
  /** The authorized account ID. */
  getAccountId(): string
  /** Server-recommended part size for large file uploads, in bytes. */
  getRecommendedPartSize(): number
  /** Smallest allowed part size for large file uploads, in bytes. */
  getAbsoluteMinimumPartSize(): number
  /** Base URL for the S3-compatible API. */
  getS3ApiUrl(): string
  /** Bucket ID the key is restricted to, or null if unrestricted. */
  getAllowedBucketId(): BucketId | null

  /** Take an upload URL from the pool for the given bucket, or null if none available. */
  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null
  /** Return a still-valid upload URL to the pool for reuse. */
  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void
  /** Remove an upload URL from the pool (e.g. after an upload error). */
  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void

  /** Take a large-file part upload URL from the pool, or null if none available. */
  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null
  /** Return a still-valid part upload URL to the pool for reuse. */
  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void
  /** Remove a part upload URL from the pool after an error. */
  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void
}
