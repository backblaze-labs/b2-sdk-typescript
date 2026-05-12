import type { EncryptionSetting } from './encryption.js'
import type { AccountId, BucketId } from './ids.js'
import type { ReplicationConfiguration } from './replication.js'

export type BucketType = 'allPublic' | 'allPrivate' | 'snapshot' | 'restricted'

export interface LifecycleRule {
  readonly daysFromHidingToDeleting: number | null
  readonly daysFromUploadingToHiding: number | null
  readonly fileNamePrefix: string
}

export interface CorsRule {
  readonly corsRuleName: string
  readonly allowedOrigins: readonly string[]
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
  readonly allowedHeaders: readonly string[] | null
  readonly exposeHeaders: readonly string[] | null
  readonly maxAgeSeconds: number
}

export type BucketRetentionMode = 'compliance' | 'governance' | 'none'

export interface BucketRetentionPolicy {
  readonly mode: BucketRetentionMode
  readonly period: { readonly duration: number; readonly unit: 'days' | 'years' } | null
}

export interface BucketInfo {
  readonly accountId: AccountId
  readonly bucketId: BucketId
  readonly bucketName: string
  readonly bucketType: BucketType
  readonly bucketInfo: Record<string, string>
  readonly corsRules: readonly CorsRule[]
  readonly defaultServerSideEncryption: EncryptionSetting
  readonly fileLockConfiguration: {
    readonly isClientAuthorizedToRead: boolean
    readonly value: {
      readonly isFileLockEnabled: boolean
      readonly defaultRetention: BucketRetentionPolicy
    } | null
  }
  readonly lifecycleRules: readonly LifecycleRule[]
  readonly options: readonly string[]
  readonly revision: number
  readonly defaultRetention: BucketRetentionPolicy
  readonly replicationConfiguration: ReplicationConfiguration
}

export interface CreateBucketRequest {
  readonly accountId: AccountId
  readonly bucketName: string
  readonly bucketType: BucketType
  readonly bucketInfo?: Record<string, string>
  readonly corsRules?: readonly CorsRule[]
  readonly defaultServerSideEncryption?: EncryptionSetting
  readonly defaultRetention?: BucketRetentionPolicy
  readonly fileLockEnabled?: boolean
  readonly lifecycleRules?: readonly LifecycleRule[]
  readonly replicationConfiguration?: ReplicationConfiguration
}

export interface UpdateBucketRequest {
  readonly accountId: AccountId
  readonly bucketId: BucketId
  readonly bucketType?: BucketType
  readonly bucketInfo?: Record<string, string>
  readonly corsRules?: readonly CorsRule[]
  readonly defaultServerSideEncryption?: EncryptionSetting
  readonly defaultRetention?: BucketRetentionPolicy
  readonly fileLockEnabled?: boolean
  readonly lifecycleRules?: readonly LifecycleRule[]
  readonly replicationConfiguration?: ReplicationConfiguration
  readonly ifRevisionIs?: number
}

export interface ListBucketsRequest {
  readonly accountId: AccountId
  readonly bucketId?: BucketId
  readonly bucketName?: string
  readonly bucketTypes?: readonly BucketType[]
}

export interface ListBucketsResponse {
  readonly buckets: readonly BucketInfo[]
}

export interface DeleteBucketRequest {
  readonly accountId: AccountId
  readonly bucketId: BucketId
}
