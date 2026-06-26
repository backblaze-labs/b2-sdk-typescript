import type { Capability } from './auth.ts'
import type { AccountId, ApplicationKeyId, BucketId } from './ids.ts'

/** Shared request parameters for creating an application key. */
export interface CreateKeyOptionsBase {
  /** Capabilities to grant to the new key. */
  readonly capabilities: readonly Capability[]
  /** Human-readable name for the key (must be unique within the account). */
  readonly keyName: string
  /** Optional duration in seconds before the key expires. Omit for a key that never expires. */
  readonly validDurationInSeconds?: number
  /** Optional file name prefix restriction. When set, the key only grants access to files with this prefix. */
  readonly namePrefix?: string
}

/** Mutually exclusive bucket scope fields for key creation. */
export type CreateKeyBucketScope =
  | {
      /**
       * Optional bucket restrictions. A bucket list restricts the key to those
       * buckets; null or omitted grants access to all buckets.
       */
      readonly bucketIds?: readonly BucketId[] | null
      /** @deprecated Use `bucketIds: [bucketId]` instead. */
      readonly bucketId?: never
    }
  | {
      /**
       * Optional single-bucket restriction.
       *
       * @deprecated Use `bucketIds: [bucketId]` instead.
       */
      readonly bucketId: BucketId
      readonly bucketIds?: never
    }

/** High-level options for creating an application key. */
export type CreateKeyOptions = CreateKeyOptionsBase & CreateKeyBucketScope

/** Request parameters for the `b2_create_key` API call. Creates a new application key. */
export type CreateKeyRequest = CreateKeyOptions & {
  /** Account to create the key for. */
  readonly accountId: AccountId
}

/**
 * Full application key including the secret, returned only at creation time by `b2_create_key`.
 * The `applicationKey` secret is never returned again after this response.
 */
export interface FullApplicationKey {
  /** Human-readable name of the key. */
  readonly keyName: string
  /** Unique identifier for the application key. */
  readonly applicationKeyId: ApplicationKeyId
  /** The secret key value. Only available in the `b2_create_key` response. */
  readonly applicationKey: string
  /** Capabilities granted to this key. */
  readonly capabilities: readonly Capability[]
  /** Account that owns this key. */
  readonly accountId: AccountId
  /** UTC timestamp (milliseconds) when this key expires, or null if it does not expire. */
  readonly expirationTimestamp: number | null
  /** Bucket IDs this key is restricted to, or null if unrestricted. */
  readonly bucketIds: readonly BucketId[] | null
  /**
   * Bucket ID this key is restricted to when it has exactly one bucket, or null
   * if unrestricted or multi-bucket.
   *
   * @deprecated Use `bucketIds` instead.
   */
  readonly bucketId: BucketId | null
  /** File name prefix this key is restricted to, or null if unrestricted. */
  readonly namePrefix: string | null
  /** Set of options enabled on this key. */
  readonly options: readonly string[]
}

/**
 * Application key metadata (without the secret) as returned by `b2_list_keys`.
 */
export interface ApplicationKey {
  /** Human-readable name of the key. */
  readonly keyName: string
  /** Unique identifier for the application key. */
  readonly applicationKeyId: ApplicationKeyId
  /** Capabilities granted to this key. */
  readonly capabilities: readonly Capability[]
  /** Account that owns this key. */
  readonly accountId: AccountId
  /** UTC timestamp (milliseconds) when this key expires, or null if it does not expire. */
  readonly expirationTimestamp: number | null
  /** Bucket IDs this key is restricted to, or null if unrestricted. */
  readonly bucketIds: readonly BucketId[] | null
  /**
   * Bucket ID this key is restricted to when it has exactly one bucket, or null
   * if unrestricted or multi-bucket.
   *
   * @deprecated Use `bucketIds` instead.
   */
  readonly bucketId: BucketId | null
  /** File name prefix this key is restricted to, or null if unrestricted. */
  readonly namePrefix: string | null
  /** Set of options enabled on this key. */
  readonly options: readonly string[]
}

/** Request parameters for the `b2_list_keys` API call. */
export interface ListKeysRequest {
  /** Account whose keys to list. */
  readonly accountId: AccountId
  /** Maximum number of keys to return per request. */
  readonly maxKeyCount?: number
  /** Application key ID to start listing from (exclusive). Used for pagination. */
  readonly startApplicationKeyId?: ApplicationKeyId
}

/** Response from the `b2_list_keys` API call. */
export interface ListKeysResponse {
  /** Array of application keys (without secrets). */
  readonly keys: readonly ApplicationKey[]
  /** Next application key ID to use for pagination, or null if all keys have been listed. */
  readonly nextApplicationKeyId: ApplicationKeyId | null
}

/** Request parameters for the `b2_delete_key` API call. */
export interface DeleteKeyRequest {
  /** ID of the application key to delete. */
  readonly applicationKeyId: ApplicationKeyId
}
