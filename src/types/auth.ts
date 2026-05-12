import type { AccountId, AuthToken, BucketId } from './ids.ts'

/**
 * A B2 API capability that can be granted to an application key.
 * Each capability controls access to a specific set of API operations.
 */
export type Capability =
  | 'listKeys'
  | 'writeKeys'
  | 'deleteKeys'
  | 'listBuckets'
  | 'listAllBucketNames'
  | 'readBuckets'
  | 'writeBuckets'
  | 'deleteBuckets'
  | 'readBucketRetentions'
  | 'writeBucketRetentions'
  | 'readBucketEncryption'
  | 'writeBucketEncryption'
  | 'readBucketReplications'
  | 'writeBucketReplications'
  | 'readBucketNotifications'
  | 'writeBucketNotifications'
  | 'listFiles'
  | 'readFiles'
  | 'shareFiles'
  | 'writeFiles'
  | 'deleteFiles'
  | 'readFileLegalHolds'
  | 'writeFileLegalHolds'
  | 'readFileRetentions'
  | 'writeFileRetentions'
  | 'bypassGovernance'

/** Describes the capabilities and scope restrictions of an authorized application key. */
export interface AllowedInfo {
  /** List of capabilities granted to this key. */
  readonly capabilities: readonly Capability[]
  /** Bucket ID this key is restricted to, or null if unrestricted. */
  readonly bucketId: BucketId | null
  /** Bucket name this key is restricted to, or null if unrestricted. */
  readonly bucketName: string | null
  /** File name prefix this key is restricted to, or null if unrestricted. */
  readonly namePrefix: string | null
}

/** Configuration for the B2 Cloud Storage API returned during authorization. */
export interface StorageApiInfo {
  /** Minimum allowed part size for large file uploads, in bytes. */
  readonly absoluteMinimumPartSize: number
  /** Base URL for B2 API calls. */
  readonly apiUrl: string
  /** Bucket ID this key is restricted to, or null if unrestricted. */
  readonly bucketId: BucketId | null
  /** Bucket name this key is restricted to, or null if unrestricted. */
  readonly bucketName: string | null
  /** Base URL for file downloads. */
  readonly downloadUrl: string
  /** Discriminator indicating this is storage API info. Always `'storageApi'`. */
  readonly infoType: 'storageApi'
  /** File name prefix this key is restricted to, or null if unrestricted. */
  readonly namePrefix: string | null
  /** Recommended part size for large file uploads, in bytes. */
  readonly recommendedPartSize: number
  /** Base URL for the S3-compatible API. */
  readonly s3ApiUrl: string
  /** Capabilities and scope of the authorized key. */
  readonly allowed: AllowedInfo
}

/** Configuration for the B2 Groups API returned during authorization. */
export interface GroupsApiInfo {
  /** Base URL for Groups API calls. */
  readonly groupsApiUrl: string
  /** Discriminator indicating this is groups API info. Always `'groupsApi'`. */
  readonly infoType: 'groupsApi'
}

/** Container for all API-specific configuration returned by `b2_authorize_account`. */
export interface ApiInfo {
  /** Storage API configuration (always present). */
  readonly storageApi: StorageApiInfo
  /** Groups API configuration (present only when the account has groups enabled). */
  readonly groupsApi?: GroupsApiInfo
}

/**
 * Response from the `b2_authorize_account` API call.
 * Contains the authorization token and API endpoint URLs needed for subsequent requests.
 */
export interface AuthorizeAccountResponse {
  /** The account ID for the authorized account. */
  readonly accountId: AccountId
  /** Authorization token to use in subsequent API calls. */
  readonly authorizationToken: AuthToken
  /** API-specific configuration including endpoint URLs and key scope. */
  readonly apiInfo: ApiInfo
  /** Expiration timestamp of the application key in milliseconds, or null if the key does not expire. */
  readonly applicationKeyExpirationTimestamp: number | null
}

/**
 * Request parameters for the `b2_authorize_account` API call.
 * Credentials are sent via HTTP Basic auth in the raw API, but represented here as fields.
 */
export interface AuthorizeAccountRequest {
  /** The application key ID (account ID or app key ID). */
  readonly applicationKeyId: string
  /** The application key secret. */
  readonly applicationKey: string
  /** Optional realm override (e.g., `'production'`, `'staging'`). Defaults to production. */
  readonly realm?: string
}
