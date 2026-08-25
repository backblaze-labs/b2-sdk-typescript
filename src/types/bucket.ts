import type { NoEncryption, PublicEncryptionSetting, SseB2Setting } from './encryption.ts'
import type { AccountId, BucketId } from './ids.ts'
import type { ReplicationConfiguration } from './replication.ts'

/**
 * Named constants for bucket types accepted by create/update bucket requests.
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

/** Bucket access levels accepted by B2 bucket create/update requests. */
export type BucketType = (typeof BucketType)[keyof typeof BucketType]

/** Named constants for documented bucket response types known to the SDK. */
export const KnownBucketResponseType = {
  ...BucketType,
  /** Response-only bucket type for buckets shared with the account. */
  Shared: 'shared',
} as const

/** Closed union of documented bucket response types known to the SDK. */
export type KnownBucketResponseType =
  (typeof KnownBucketResponseType)[keyof typeof KnownBucketResponseType]

/** Bucket type returned by B2 bucket responses, including future B2-added values. */
export type BucketResponseType = KnownBucketResponseType | (string & {})

/**
 * Bucket type value accepted by `b2_list_buckets.bucketTypes`.
 *
 * This includes future B2-added strings, so TypeScript cannot statically exclude
 * the special `'all'` value from this open string type. Runtime validation still
 * enforces that `'all'` is only valid as `['all']` and that filters are non-empty.
 */
export type BucketListType = BucketResponseType

/**
 * Bucket type filter accepted by `b2_list_buckets`.
 *
 * Use `['all']` by itself to request all bucket types. Other filters may include
 * documented response types such as `'shared'` and future B2-added type strings.
 * Because future bucket types are modeled as an open string, TypeScript cannot
 * reject empty arrays or mixed arrays containing `'all'`; B2 and the simulator
 * reject them at runtime.
 */
export type BucketTypesFilter = readonly ['all'] | readonly BucketListType[]

/**
 * Named constants for option flags returned on buckets and application keys.
 *
 * B2 currently documents only the S3-compatible API option.
 */
export const BucketKeyOption = {
  /** Enables the S3-compatible API surface for the bucket or key. */
  S3: 's3',
} as const

/** Documented option flag returned on bucket and application key metadata. */
export type KnownBucketKeyOption = (typeof BucketKeyOption)[keyof typeof BucketKeyOption]

/** Option flag returned on bucket and application key metadata, open to future B2-added strings. */
export type BucketKeyOption = KnownBucketKeyOption | (string & {})

/** Minimum UTF-8 byte length for each bucketInfo key. */
export const BUCKET_INFO_KEY_MIN_BYTES = 1
/** Maximum UTF-8 byte length for each bucketInfo key. */
export const BUCKET_INFO_KEY_MAX_BYTES = 50
/** Maximum aggregate UTF-8 byte length of all bucketInfo values. */
export const BUCKET_INFO_VALUES_MAX_BYTES = 10_000
/** Reserved bucketInfo key prefix used by Backblaze. */
export const BUCKET_INFO_RESERVED_PREFIX = 'b2-'
/**
 * BucketInfo keys must match this regular-expression source. B2 accepts
 * letters, digits, and these characters: `. _ ~ ! # $ % ^ & * ' | + -` plus the
 * backtick.
 */
export const BUCKET_INFO_KEY_PATTERN = "^[A-Za-z0-9._`~!#$%^&*'|+-]+$"

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
  /** S3-compatible GET. */
  S3Get: 's3_get',
  /**
   * S3-compatible POST.
   *
   * @deprecated B2 bucket CORS rules do not accept `s3_post`. This member is
   * preserved so existing imports continue to compile. Use one of
   * {@link CORS_ALLOWED_OPERATIONS} for newly validated bucket CORS rules.
   */
  S3Post: 's3_post',
  /** S3-compatible PUT. */
  S3Put: 's3_put',
  /** S3-compatible HEAD. */
  S3Head: 's3_head',
  /** S3-compatible DELETE. */
  S3Delete: 's3_delete',
} as const

/**
 * A B2 or S3 operation that a CORS rule can permit. Derived from
 * {@link CorsOperation}.
 *
 * @remarks This includes the deprecated `s3_post` compatibility member. Use
 * {@link CorsAllowedOperation} for bucket CORS rules accepted by B2.
 */
export type CorsOperation = (typeof CorsOperation)[keyof typeof CorsOperation]

/** All CORS operations accepted by B2 bucket CORS rules. */
export const CORS_ALLOWED_OPERATIONS = [
  CorsOperation.B2DownloadFileByName,
  CorsOperation.B2DownloadFileById,
  CorsOperation.B2UploadFile,
  CorsOperation.B2UploadPart,
  CorsOperation.S3Get,
  CorsOperation.S3Put,
  CorsOperation.S3Head,
  CorsOperation.S3Delete,
] as const satisfies readonly CorsOperation[]

/** B2 bucket CORS operation values accepted by validated CORS rules. */
export type CorsAllowedOperation = (typeof CORS_ALLOWED_OPERATIONS)[number]

/** Maximum number of CORS rules allowed on a bucket. */
export const CORS_RULES_MAX_COUNT = 100
/** Minimum character length for a CORS rule name. */
export const CORS_RULE_NAME_MIN_LENGTH = 6
/** Maximum character length for a CORS rule name. */
export const CORS_RULE_NAME_MAX_LENGTH = 63
/** CORS rule names must match this regular-expression source. */
export const CORS_RULE_NAME_PATTERN = '^[A-Za-z0-9-]+$'
/** Reserved CORS rule-name prefix used by Backblaze. */
export const CORS_RULE_NAME_RESERVED_PREFIX = 'b2-'
/** Exclusive UTF-8 byte-size ceiling for each CORS rule definition. */
export const CORS_RULE_MAX_BYTES = 1_000
/** Maximum accepted CORS preflight cache duration in seconds. */
export const CORS_MAX_AGE_SECONDS_MAX = 86_400

/**
 * Cross-Origin Resource Sharing (CORS) rule for browser-based access to a bucket.
 * A bucket may have up to {@link CORS_RULES_MAX_COUNT} rules, and each rule's
 * name, allowed origins, allowed operations, allowed headers, and exposed
 * headers must total less than {@link CORS_RULE_MAX_BYTES} UTF-8 bytes.
 */
export interface CorsRule {
  /**
   * Unique name identifying this CORS rule within the bucket.
   * Must be 6-63 characters, match `[A-Za-z0-9-]`, and not start with `b2-`.
   */
  readonly corsRuleName: string
  /**
   * Origins allowed to make cross-origin requests (e.g., `'https://example.com'`).
   * At least one origin is required.
   */
  readonly allowedOrigins: readonly string[]
  /**
   * B2 and S3 operations permitted by this rule.
   * At least one operation is required, and every value must be from
   * {@link CORS_ALLOWED_OPERATIONS}.
   */
  readonly allowedOperations: readonly CorsAllowedOperation[]
  /**
   * Request headers allowed in preflight requests, or null/omitted if none are allowed.
   */
  readonly allowedHeaders?: readonly string[] | null
  /**
   * Response headers exposed to the browser, or null/omitted if none are exposed.
   */
  readonly exposeHeaders?: readonly string[] | null
  /** Maximum time (0-86400 seconds) browsers may cache the preflight response. */
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
export type BucketDefaultServerSideEncryption = PublicEncryptionSetting

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
  /** Access level or response-only type of this bucket. */
  readonly bucketType: BucketResponseType
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
  /** Set of options enabled on this bucket (e.g., {@link BucketKeyOption.S3}). */
  readonly options: readonly BucketKeyOption[]
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
  /**
   * Optional user-defined key-value metadata.
   * Keys must be 1-50 UTF-8 bytes and must not start with `b2-`; the aggregate
   * UTF-8 byte length of all values must be at most 10,000 bytes. Keys must
   * match {@link BUCKET_INFO_KEY_PATTERN}. BucketInfo has no documented
   * pair-count cap.
   */
  readonly bucketInfo?: Record<string, string>
  /**
   * Optional CORS rules.
   * A bucket may have at most 100 rules. Each rule name must be unique, 6-63
   * characters, match `[A-Za-z0-9-]`, and not start with `b2-`. Each rule's
   * name, origins, operations, allowed headers, and exposed headers must total
   * less than 1,000 UTF-8 bytes. `maxAgeSeconds` must be at most 86,400.
   */
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
  /**
   * Updated user-defined key-value metadata. Replaces all existing metadata.
   * Keys must be 1-50 UTF-8 bytes and must not start with `b2-`; the aggregate
   * UTF-8 byte length of all values must be at most 10,000 bytes. Keys must
   * match {@link BUCKET_INFO_KEY_PATTERN}. BucketInfo has no documented
   * pair-count cap.
   */
  readonly bucketInfo?: Record<string, string>
  /**
   * Updated CORS rules. Replaces all existing rules.
   * A bucket may have at most 100 rules. Each rule name must be unique, 6-63
   * characters, match `[A-Za-z0-9-]`, and not start with `b2-`. Each rule's
   * name, origins, operations, allowed headers, and exposed headers must total
   * less than 1,000 UTF-8 bytes. `maxAgeSeconds` must be at most 86,400.
   */
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
  readonly bucketTypes?: BucketTypesFilter
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
