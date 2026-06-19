import type { AccountId, AuthToken, BucketId } from './ids.ts'

/**
 * Named constants for the B2 API capabilities that can be granted to an
 * application key. Each capability controls access to a specific set of
 * API operations.
 *
 * Use these when constructing the `capabilities` array for an application
 * key request, or when checking required capabilities via
 * `B2Client.hasCapabilities`.
 *
 * @example
 * ```ts
 * const check = client.hasCapabilities([Capability.WriteFiles, Capability.ReadFiles])
 * if (!check.ok) throw new Error(`missing: ${check.missing.join(', ')}`)
 * ```
 */
export const Capability = {
  /** List application keys. */
  ListKeys: 'listKeys',
  /** Create new application keys. */
  WriteKeys: 'writeKeys',
  /** Delete application keys. */
  DeleteKeys: 'deleteKeys',
  /** List buckets (subject to key restrictions). */
  ListBuckets: 'listBuckets',
  /** List bucket names without other metadata. */
  ListAllBucketNames: 'listAllBucketNames',
  /** Read bucket settings. */
  ReadBuckets: 'readBuckets',
  /** Create and update buckets. */
  WriteBuckets: 'writeBuckets',
  /** Remove existing buckets from the account. */
  DeleteBuckets: 'deleteBuckets',
  /** Read bucket-level Object Lock retention settings. */
  ReadBucketRetentions: 'readBucketRetentions',
  /** Modify bucket-level Object Lock retention settings. */
  WriteBucketRetentions: 'writeBucketRetentions',
  /** Read default bucket encryption settings. */
  ReadBucketEncryption: 'readBucketEncryption',
  /** Modify default bucket encryption settings. */
  WriteBucketEncryption: 'writeBucketEncryption',
  /** Read bucket replication configuration. */
  ReadBucketReplications: 'readBucketReplications',
  /** Modify bucket replication configuration. */
  WriteBucketReplications: 'writeBucketReplications',
  /** Read bucket event-notification rules. */
  ReadBucketNotifications: 'readBucketNotifications',
  /** Modify bucket event-notification rules. */
  WriteBucketNotifications: 'writeBucketNotifications',
  /** List file names and versions. */
  ListFiles: 'listFiles',
  /** Download files. */
  ReadFiles: 'readFiles',
  /** Mint download authorisation tokens. */
  ShareFiles: 'shareFiles',
  /** Upload files. */
  WriteFiles: 'writeFiles',
  /** Delete file versions. */
  DeleteFiles: 'deleteFiles',
  /** Read per-file legal hold flags. */
  ReadFileLegalHolds: 'readFileLegalHolds',
  /** Modify per-file legal hold flags. */
  WriteFileLegalHolds: 'writeFileLegalHolds',
  /** Read per-file Object Lock retention settings. */
  ReadFileRetentions: 'readFileRetentions',
  /** Modify per-file Object Lock retention settings. */
  WriteFileRetentions: 'writeFileRetentions',
  /** Shorten governance-mode retention. */
  BypassGovernance: 'bypassGovernance',
} as const

/**
 * A B2 API capability that can be granted to an application key. Derived
 * from {@link Capability}.
 */
export type Capability = (typeof Capability)[keyof typeof Capability]

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
  /**
   * Optional realm override. Accepts a known realm-map key or a direct base
   * URL. Custom HTTPS hosts are trusted with the application key during
   * authorize, so never derive this value from untrusted input. URL values must
   * use HTTPS, or loopback HTTP for local testing only; application-key
   * credentials are sent unencrypted over loopback HTTP. Unsupported schemes,
   * malformed URLs, non-URL strings, and non-loopback plaintext HTTP are
   * rejected before credentials are sent. Defaults to production.
   */
  readonly realm?: string
}
