import type { NoEncryption, NoEncryptionWireSetting, SseB2Setting } from './encryption.ts'
import type { AccountId, BucketId } from './ids.ts'
import type { ReplicationConfiguration } from './replication.ts'

/**
 * Named constants for the bucket access level.
 *
 * The {@link BucketType} type alias is derived from the values of this
 * object, so the const is the single source of truth: adding a key here
 * automatically widens the type union.
 *
 * @example
 * ```ts
 * await client.createBucket({ bucketName: 'my-app-logs', bucketType: BucketType.AllPrivate })
 * ```
 */
export const BucketType = {
  /** Publicly downloadable without authentication. */
  AllPublic: 'allPublic',
  /** Requires a valid auth token to download. */
  AllPrivate: 'allPrivate',
  /** Internal snapshot bucket type, generally not user-created. */
  Snapshot: 'snapshot',
  /** B2-restricted bucket (e.g., for S3-compatible workflows). */
  Restricted: 'restricted',
} as const

/** Access level for a B2 bucket. Derived from {@link BucketType}. */
export type BucketType = (typeof BucketType)[keyof typeof BucketType]

/** Rule that automatically hides or deletes files after a specified number of days. */
export interface LifecycleRule {
  /** Days after hiding before automatic deletion, or null to never auto-delete hidden files. */
  readonly daysFromHidingToDeleting?: number | null
  /** Days after upload before automatic hiding, or null to never auto-hide. */
  readonly daysFromUploadingToHiding?: number | null
  /** Days after starting before automatic cancellation of unfinished large files, or null to never auto-cancel. */
  readonly daysFromStartingToCancelingUnfinishedLargeFiles?: number | null
  /** File name prefix this rule applies to. Empty string matches all files. */
  readonly fileNamePrefix: string
}

/**
 * Named constants for the B2 + S3 operations a CORS rule can permit.
 *
 * @example
 * ```ts
 * await bucket.update({
 *   corsRules: [{
 *     corsRuleName: 'browser-downloads',
 *     allowedOrigins: ['https://example.com'],
 *     allowedOperations: [CorsOperation.B2DownloadFileByName, CorsOperation.S3Get],
 *     allowedHeaders: null,
 *     exposeHeaders: null,
 *     maxAgeSeconds: 3600,
 *   }],
 * })
 * ```
 */
export const CorsOperation = {
  /** Native B2 download-by-name request. */
  B2DownloadFileByName: 'b2_download_file_by_name',
  /** Native B2 download-by-id request. */
  B2DownloadFileById: 'b2_download_file_by_id',
  /** Native B2 small-file upload. */
  B2UploadFile: 'b2_upload_file',
  /** Native B2 multipart-part upload. */
  B2UploadPart: 'b2_upload_part',
  /** S3-compatible DELETE. */
  S3Delete: 's3_delete',
  /** S3-compatible GET. */
  S3Get: 's3_get',
  /** S3-compatible HEAD. */
  S3Head: 's3_head',
  /** S3-compatible POST. */
  S3Post: 's3_post',
  /** S3-compatible PUT. */
  S3Put: 's3_put',
} as const

/**
 * A B2 or S3 operation that a CORS rule can permit. Derived from
 * {@link CorsOperation}.
 */
export type CorsOperation = (typeof CorsOperation)[keyof typeof CorsOperation]

/** Cross-Origin Resource Sharing (CORS) rule for browser-based access to a bucket. */
export interface CorsRule {
  /** Unique name identifying this CORS rule within the bucket. */
  readonly corsRuleName: string
  /** Origins allowed to make cross-origin requests (e.g., `'https://example.com'`). */
  readonly allowedOrigins: readonly string[]
  /** B2 and S3 operations permitted by this rule. */
  readonly allowedOperations: readonly CorsOperation[]
  /** Request headers allowed in preflight requests, or null if none are allowed. */
  readonly allowedHeaders: readonly string[] | null
  /** Response headers exposed to the browser, or null if none are exposed. */
  readonly exposeHeaders: readonly string[] | null
  /** Maximum time (in seconds) browsers may cache the preflight response. */
  readonly maxAgeSeconds: number
}

/**
 * Named constants for the bucket-level Object Lock retention mode.
 *
 * Pair with {@link BucketRetentionPolicy} when setting a bucket's default
 * retention: `{ mode: BucketRetentionMode.Compliance, period: { duration: 30, unit: 'days' } }`.
 */
export const BucketRetentionMode = {
  /** Files cannot be deleted or modified during the retention period, even by the account owner. */
  Compliance: 'compliance',
  /** Files cannot be deleted during retention except by callers with the `bypassGovernance` capability. */
  Governance: 'governance',
  /** No default retention is applied to new uploads. */
  None: 'none',
} as const

/** Bucket-level Object Lock retention mode. Derived from {@link BucketRetentionMode}. */
export type BucketRetentionMode = (typeof BucketRetentionMode)[keyof typeof BucketRetentionMode]

/** Duration and unit for a retention period. */
export interface RetentionPeriod {
  /** Length of the retention period. */
  readonly duration: number
  /** Time unit for the retention period. */
  readonly unit: 'days' | 'years'
}

/** Default Object Lock retention policy applied to new files in a bucket. */
export interface BucketRetentionPolicy {
  /** Retention mode for the policy. */
  readonly mode: BucketRetentionMode
  /** Retention period, or null when mode is `'none'`. */
  readonly period: RetentionPeriod | null
}

/** B2 response shape for a bucket with no default Object Lock retention. */
export interface NoBucketDefaultRetention {
  /** B2 returns null when no bucket default retention policy is configured. */
  readonly mode: null
  /** No retention period is configured. */
  readonly period: null
}

/** Default Object Lock retention as returned in bucket metadata. */
export type BucketDefaultRetention = BucketRetentionPolicy | NoBucketDefaultRetention

/** Cross-region replication settings as returned by readable B2 bucket metadata. */
export interface ReadableReplicationConfiguration {
  /** Whether the caller is authorized to read replication settings. */
  readonly isClientAuthorizedToRead: boolean
  /** Replication settings, or null when none are configured or the caller is not authorized to read them. */
  readonly value: ReplicationConfiguration | null
}

/** Bucket default server-side encryption setting returned by B2 bucket responses. */
export type BucketDefaultServerSideEncryption = SseB2Setting | NoEncryptionWireSetting

/** Bucket default server-side encryption setting accepted by B2 bucket requests. */
export type BucketDefaultServerSideEncryptionSetting = SseB2Setting | NoEncryption

/**
 * Complete bucket metadata as returned by the B2 API.
 * Corresponds to the bucket object in responses from `b2_list_buckets`, `b2_create_bucket`, and `b2_update_bucket`.
 */
export interface BucketInfo {
  /** Account that owns this bucket. */
  readonly accountId: AccountId
  /** Unique identifier for this bucket. */
  readonly bucketId: BucketId
  /** Globally unique name of this bucket. */
  readonly bucketName: string
  /** Access level of this bucket. */
  readonly bucketType: BucketType
  /** User-defined key-value metadata stored on the bucket. */
  readonly bucketInfo: Record<string, string>
  /** CORS rules configured on this bucket. */
  readonly corsRules: readonly CorsRule[]
  /** Default server-side encryption setting for new files in this bucket. */
  readonly defaultServerSideEncryption: {
    /** Whether the caller is authorized to read default server-side encryption settings. */
    readonly isClientAuthorizedToRead: boolean
    /** Default server-side encryption settings, or null if the caller lacks read authorization. */
    readonly value: BucketDefaultServerSideEncryption | null
  }
  /** File Lock configuration including authorization status and current settings. */
  readonly fileLockConfiguration: {
    /** Whether the caller is authorized to read file lock settings. */
    readonly isClientAuthorizedToRead: boolean
    /** File lock settings, or null if the caller lacks read authorization. */
    readonly value: {
      /** Whether Object Lock is enabled on this bucket. */
      readonly isFileLockEnabled: boolean
      /** Default retention policy for newly uploaded files. */
      readonly defaultRetention: BucketDefaultRetention
    } | null
  }
  /** Lifecycle rules configured on this bucket. */
  readonly lifecycleRules: readonly LifecycleRule[]
  /** Set of options enabled on this bucket (e.g., `'s3'`). */
  readonly options: readonly string[]
  /** Monotonically increasing revision number, incremented on each bucket update. */
  readonly revision: number
  /** Cross-region replication configuration, filtered by caller authorization. */
  readonly replicationConfiguration: ReadableReplicationConfiguration
}

/**
 * Request parameters for the `b2_create_bucket` API call.
 */
export interface CreateBucketRequest {
  /** Account that will own the new bucket. */
  readonly accountId: AccountId
  /** Globally unique name for the bucket. */
  readonly bucketName: string
  /** Access level for the bucket. */
  readonly bucketType: BucketType
  /** Optional user-defined key-value metadata. */
  readonly bucketInfo?: Record<string, string>
  /** Optional CORS rules. */
  readonly corsRules?: readonly CorsRule[]
  /** Optional default server-side encryption setting. */
  readonly defaultServerSideEncryption?: BucketDefaultServerSideEncryptionSetting
  /** Optional default Object Lock retention policy. */
  readonly defaultRetention?: BucketRetentionPolicy
  /** Whether to enable Object Lock on the bucket. Cannot be changed after creation. */
  readonly fileLockEnabled?: boolean
  /** Optional lifecycle rules. */
  readonly lifecycleRules?: readonly LifecycleRule[]
  /** Optional replication configuration. */
  readonly replicationConfiguration?: ReplicationConfiguration
}

/**
 * Request parameters for the `b2_update_bucket` API call.
 */
export interface UpdateBucketRequest {
  /** Account that owns the bucket. */
  readonly accountId: AccountId
  /** ID of the bucket to update. */
  readonly bucketId: BucketId
  /** New access level for the bucket. */
  readonly bucketType?: BucketType
  /** Updated user-defined key-value metadata. Replaces all existing metadata. */
  readonly bucketInfo?: Record<string, string>
  /** Updated CORS rules. Replaces all existing rules. */
  readonly corsRules?: readonly CorsRule[]
  /** Updated default server-side encryption setting. */
  readonly defaultServerSideEncryption?: BucketDefaultServerSideEncryptionSetting
  /** Updated default Object Lock retention policy. */
  readonly defaultRetention?: BucketRetentionPolicy
  /** Whether to enable Object Lock. Can only transition from disabled to enabled. */
  readonly fileLockEnabled?: boolean
  /** Updated lifecycle rules. Replaces all existing rules. */
  readonly lifecycleRules?: readonly LifecycleRule[]
  /** Updated replication configuration. */
  readonly replicationConfiguration?: ReplicationConfiguration
  /** Optimistic locking: only update if the bucket's current revision matches this value. */
  readonly ifRevisionIs?: number
}

/**
 * Request parameters for the `b2_list_buckets` API call.
 */
export interface ListBucketsRequest {
  /** Account whose buckets to list. */
  readonly accountId: AccountId
  /** Optional filter to return only the bucket with this ID. */
  readonly bucketId?: BucketId
  /** Optional filter to return only the bucket with this name. */
  readonly bucketName?: string
  /** Optional filter to return only buckets of these types. */
  readonly bucketTypes?: readonly BucketType[]
}

/** Response from the `b2_list_buckets` API call. */
export interface ListBucketsResponse {
  /** Array of buckets matching the request filters. */
  readonly buckets: readonly BucketInfo[]
}

/**
 * Request parameters for the `b2_delete_bucket` API call.
 */
export interface DeleteBucketRequest {
  /** Account that owns the bucket. */
  readonly accountId: AccountId
  /** ID of the bucket to delete. The bucket must be empty. */
  readonly bucketId: BucketId
}
