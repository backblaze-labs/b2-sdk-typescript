import type { BucketId } from './ids.js'

export type EventType =
  | 'b2:ObjectCreated:*'
  | 'b2:ObjectCreated:Upload'
  | 'b2:ObjectCreated:MultipartUpload'
  | 'b2:ObjectCreated:Copy'
  | 'b2:ObjectCreated:Replica'
  | 'b2:ObjectCreated:Hide'
  | 'b2:ObjectDeleted:*'
  | 'b2:ObjectDeleted:Delete'
  | 'b2:ObjectDeleted:LifecycleRule'

export interface EventNotificationRule {
  readonly eventTypes: readonly EventType[]
  readonly isEnabled: boolean
  readonly isSuspended: boolean
  readonly name: string
  readonly objectNamePrefix: string
  readonly suspensionReason: string
  readonly targetConfiguration: {
    readonly targetType: string
    readonly url: string
    readonly hmacSha256SigningSecret?: string
    readonly customHeaders?: Record<string, string>
  }
}

export interface GetBucketNotificationRulesRequest {
  readonly bucketId: BucketId
}

export interface GetBucketNotificationRulesResponse {
  readonly bucketId: BucketId
  readonly eventNotificationRules: readonly EventNotificationRule[]
}

export interface SetBucketNotificationRulesRequest {
  readonly bucketId: BucketId
  readonly eventNotificationRules: readonly EventNotificationRule[]
}

export type SetBucketNotificationRulesResponse = GetBucketNotificationRulesResponse
