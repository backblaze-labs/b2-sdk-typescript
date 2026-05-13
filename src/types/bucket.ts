import type { EncryptionSetting } from './encryption.ts'
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
 * await client.createBucket({ bucketName: 'logs', bucketType: BucketType.AllPrivate })
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
  readonly daysFromHidingToDeleting: number | null
  /** Days after upload before automatic hiding, or null to never auto-hide. */
  readonly daysFromUploadingToHiding: number | null
  /** File name prefix this rule applies to. Empty string matches all files. */
  readonly fileNamePrefix: string
}

/** Cross-Origin Resource Sharing (CORS) rule for browser-based access to a bucket. */
export interface CorsRule {
  /** Unique name identifying this CORS rule within the bucket. */
  readonly corsRuleName: string
  /** Origins allowed to make cross-origin requests (e.g., `'https://example.com'`). */
  readonly allowedOrigins: readonly string[]
  /** B2 and S3 operations permitted by this rule. */
  readonly allowedOperations: readonly (
    | 'b2_download_file_by_name'
    | 'b2_download_file_by_id'
    | 'b2_upload_file'
    | 'b2_upload_part'
    | 's3_delete'
    | 's3_get'
    | 's3_head'
    | 's3_post'
    | 's3_put'
  )[]
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
  readonly defaultServerSideEncryption: EncryptionSetting
  /** File Lock configuration including authorization status and current settings. */
  readonly fileLockConfiguration: {
    /** Whether the caller is authorized to read file lock settings. */
    readonly isClientAuthorizedToRead: boolean
    /** File lock settings, or null if the caller lacks read authorization. */
    readonly value: {
      /** Whether Object Lock is enabled on this bucket. */
      readonly isFileLockEnabled: boolean
      /** Default retention policy for newly uploaded files. */
      readonly defaultRetention: BucketRetentionPolicy
    } | null
  }
  /** Lifecycle rules configured on this bucket. */
  readonly lifecycleRules: readonly LifecycleRule[]
  /** Set of options enabled on this bucket (e.g., `'s3'`). */
  readonly options: readonly string[]
  /** Monotonically increasing revision number, incremented on each bucket update. */
  readonly revision: number
  /** Default retention policy for newly uploaded files. */
  readonly defaultRetention: BucketRetentionPolicy
  /** Cross-region replication configuration for this bucket. */
  readonly replicationConfiguration: ReplicationConfiguration
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
  readonly defaultServerSideEncryption?: EncryptionSetting
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
  readonly defaultServerSideEncryption?: EncryptionSetting
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
