import type { BucketId } from './ids.ts'

/**
 * Named constants for the B2 event types that can trigger notifications.
 *
 * Wildcard variants (`ObjectCreatedAll`, `ObjectDeletedAll`) subscribe to
 * every sub-event in their category.
 *
 * @example
 * ```ts
 * await bucket.setNotificationRules([
 *   {
 *     name: 'all-uploads',
 *     eventTypes: [EventType.ObjectCreatedAll],
 *     isEnabled: true,
 *     isSuspended: false,
 *     objectNamePrefix: '',
 *     suspensionReason: '',
 *     targetConfiguration: { targetType: 'webhook', url: 'https://example.com/webhook' },
 *   },
 * ])
 * ```
 */
export const EventType = {
  /** Wildcard: any `b2:ObjectCreated:*` sub-event. */
  ObjectCreatedAll: 'b2:ObjectCreated:*',
  /** A small-file upload (`b2_upload_file`). */
  ObjectCreatedUpload: 'b2:ObjectCreated:Upload',
  /** A multipart upload completed (`b2_finish_large_file`). */
  ObjectCreatedMultipartUpload: 'b2:ObjectCreated:MultipartUpload',
  /** A server-side copy (`b2_copy_file` or `b2_copy_part`). */
  ObjectCreatedCopy: 'b2:ObjectCreated:Copy',
  /** A replica delivered via cross-region replication. */
  ObjectCreatedReplica: 'b2:ObjectCreated:Replica',
  /** A hide marker was created (`b2_hide_file`). */
  ObjectCreatedHide: 'b2:ObjectCreated:Hide',
  /** Wildcard: any `b2:ObjectDeleted:*` sub-event. */
  ObjectDeletedAll: 'b2:ObjectDeleted:*',
  /** A version was permanently deleted (`b2_delete_file_version`). */
  ObjectDeletedDelete: 'b2:ObjectDeleted:Delete',
  /** A version was removed by a lifecycle rule. */
  ObjectDeletedLifecycleRule: 'b2:ObjectDeleted:LifecycleRule',
} as const

/**
 * B2 event types that can trigger notifications. Derived from {@link EventType}.
 */
export type EventType = (typeof EventType)[keyof typeof EventType]

/** A custom HTTP header included with event-notification webhook requests. */
export interface EventNotificationCustomHeader {
  /** Header name. */
  readonly name: string
  /** Header value. */
  readonly value: string
}

/**
 * Convert B2's wire-shaped custom headers to a lookup record.
 *
 * Duplicate header names are represented by the last value in the array.
 *
 * @param customHeaders - Wire-shaped custom headers from an event-notification rule.
 *
 * @returns A name/value lookup record.
 */
export function notificationCustomHeadersToRecord(
  customHeaders: readonly EventNotificationCustomHeader[] | undefined,
): Record<string, string> {
  const record: Record<string, string> = {}
  for (const { name, value } of customHeaders ?? []) {
    record[name] = value
  }
  return record
}

/**
 * Convert a lookup record to B2's wire-shaped custom headers.
 *
 * @param customHeaders - Name/value header lookup.
 *
 * @returns Wire-shaped custom headers for an event-notification rule.
 */
export function recordToNotificationCustomHeaders(
  customHeaders: Readonly<Record<string, string>> | undefined,
): EventNotificationCustomHeader[] {
  if (customHeaders === undefined) return []
  return Object.entries(customHeaders).map(([name, value]) => ({ name, value }))
}

/** A rule that defines which bucket events trigger webhook notifications and where they are sent. */
export interface EventNotificationRule {
  /** Event types that trigger this notification rule. */
  readonly eventTypes: readonly EventType[]
  /** Whether this rule is actively sending notifications. */
  readonly isEnabled: boolean
  /** Whether B2 has suspended this rule due to delivery failures. */
  readonly isSuspended: boolean
  /** Maximum number of events B2 may include in a single webhook request. */
  readonly maxEventsPerBatch?: number
  /** Unique name identifying this rule within the bucket. */
  readonly name: string
  /** Only events for objects with this name prefix trigger the rule. Empty string matches all objects. */
  readonly objectNamePrefix: string
  /** Reason for suspension, or empty string if not suspended. */
  readonly suspensionReason: string
  /** Webhook target configuration. */
  readonly targetConfiguration: {
    /** Target type (`'webhook'` for webhook delivery). */
    readonly targetType: 'webhook'
    /** Webhook URL that receives the event notifications. */
    readonly url: string
    /** Optional HMAC-SHA256 secret used to sign notification payloads for verification. */
    readonly hmacSha256SigningSecret?: string
    /** Optional custom headers included in webhook requests. */
    readonly customHeaders?: readonly EventNotificationCustomHeader[]
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
