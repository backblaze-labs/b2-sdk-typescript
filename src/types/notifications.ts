import type { BucketId } from './ids.ts'

/**
 * B2 event types that can trigger notifications.
 * Wildcard patterns (e.g., `'b2:ObjectCreated:*'`) match all sub-events in that category.
 */
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

/** A rule that defines which bucket events trigger webhook notifications and where they are sent. */
export interface EventNotificationRule {
  /** Event types that trigger this notification rule. */
  readonly eventTypes: readonly EventType[]
  /** Whether this rule is actively sending notifications. */
  readonly isEnabled: boolean
  /** Whether B2 has suspended this rule due to delivery failures. */
  readonly isSuspended: boolean
  /** Unique name identifying this rule within the bucket. */
  readonly name: string
  /** Only events for objects with this name prefix trigger the rule. Empty string matches all objects. */
  readonly objectNamePrefix: string
  /** Reason for suspension, or empty string if not suspended. */
  readonly suspensionReason: string
  /** Webhook target configuration. */
  readonly targetConfiguration: {
    /** Target type (e.g., `'url'` for webhook delivery). */
    readonly targetType: string
    /** Webhook URL that receives the event notifications. */
    readonly url: string
    /** Optional HMAC-SHA256 secret used to sign notification payloads for verification. */
    readonly hmacSha256SigningSecret?: string
    /** Optional custom headers included in webhook requests. */
    readonly customHeaders?: Record<string, string>
  }
}

/** Request parameters for the `b2_get_bucket_notification_rules` API call. */
export interface GetBucketNotificationRulesRequest {
  /** Bucket to get notification rules for. */
  readonly bucketId: BucketId
}

/** Response from the `b2_get_bucket_notification_rules` API call. */
export interface GetBucketNotificationRulesResponse {
  /** Bucket these rules belong to. */
  readonly bucketId: BucketId
  /** Array of event notification rules configured on the bucket. */
  readonly eventNotificationRules: readonly EventNotificationRule[]
}

/**
 * Request parameters for the `b2_set_bucket_notification_rules` API call.
 * Replaces all existing notification rules on the bucket.
 */
export interface SetBucketNotificationRulesRequest {
  /** Bucket to set notification rules on. */
  readonly bucketId: BucketId
  /** Notification rules to apply. Replaces all existing rules. */
  readonly eventNotificationRules: readonly EventNotificationRule[]
}

/** Response from the `b2_set_bucket_notification_rules` API call. Same shape as the get response. */
export type SetBucketNotificationRulesResponse = GetBucketNotificationRulesResponse
