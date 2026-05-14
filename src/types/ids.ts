/**
 * Unique symbol used to brand string types, preventing accidental mixing of different ID types.
 */
declare const __brand: unique symbol

/** Compile-time brand tag interface. Never instantiated at runtime. */
export interface BrandTag<B extends string> {
  /** Discriminant tag that makes branded types structurally incompatible. */
  readonly [__brand]: B
}

/**
 * Utility type that intersects a base type with a branded tag.
 * This pattern ensures that branded types are structurally incompatible with each other
 * even though they share the same underlying representation.
 */
export type Brand<T, B extends string> = T & BrandTag<B>

/** Unique identifier for a B2 account. Branded to prevent mixing with other string IDs. */
export type AccountId = Brand<string, 'AccountId'>

/** Unique identifier for a B2 bucket. Branded to prevent mixing with other string IDs. */
export type BucketId = Brand<string, 'BucketId'>

/** Unique identifier for a B2 file version. Branded to prevent mixing with other string IDs. */
export type FileId = Brand<string, 'FileId'>

/** Unique identifier for a B2 application key. Branded to prevent mixing with other string IDs. */
export type KeyId = Brand<string, 'KeyId'>

/** Unique identifier for a B2 application key, as returned by the API. Branded to prevent mixing with other string IDs. */
export type ApplicationKeyId = Brand<string, 'ApplicationKeyId'>

/** Pre-signed URL for uploading files to a specific bucket. Branded to prevent misuse as a regular string. */
export type UploadUrl = Brand<string, 'UploadUrl'>

/** Authorization token scoped to a specific upload URL. Branded to prevent mixing with other tokens. */
export type UploadAuthToken = Brand<string, 'UploadAuthToken'>

/** Authorization token for B2 API requests. Branded to prevent mixing with other string values. */
export type AuthToken = Brand<string, 'AuthToken'>

/** Unique identifier for a large file upload in progress. Branded to prevent mixing with regular FileId values. */
export type LargeFileId = Brand<string, 'LargeFileId'>

/**
 * Creates a branded {@link AccountId} from a raw string.
 * @param raw - The raw account ID string from the B2 API.
 *
 * @returns A branded AccountId value.
 */
export function accountId(raw: string): AccountId {
  return raw as AccountId
}

/**
 * Creates a branded {@link BucketId} from a raw string.
 * @param raw - The raw bucket ID string from the B2 API.
 *
 * @returns A branded BucketId value.
 */
export function bucketId(raw: string): BucketId {
  return raw as BucketId
}

/**
 * Creates a branded {@link FileId} from a raw string.
 * @param raw - The raw file ID string from the B2 API.
 *
 * @returns A branded FileId value.
 */
export function fileId(raw: string): FileId {
  return raw as FileId
}

/**
 * Creates a branded {@link KeyId} from a raw string.
 * @param raw - The raw key ID string from the B2 API.
 *
 * @returns A branded KeyId value.
 */
export function keyId(raw: string): KeyId {
  return raw as KeyId
}

/**
 * Creates a branded {@link ApplicationKeyId} from a raw string.
 * @param raw - The raw application key ID string from the B2 API.
 *
 * @returns A branded ApplicationKeyId value.
 */
export function applicationKeyId(raw: string): ApplicationKeyId {
  return raw as ApplicationKeyId
}

/**
 * Creates a branded {@link LargeFileId} from a raw string.
 *
 * `LargeFileId` is the same wire-level shape as `FileId` but is a
 * distinct brand so that "ID of an in-progress multipart upload" and
 * "ID of a committed file version" don't get mixed up by accident.
 * `b2_start_large_file` returns one; `b2_finish_large_file` consumes it
 * and produces a regular `FileId`.
 *
 * @param raw - The raw large-file ID string from the B2 API.
 *
 * @returns A branded LargeFileId value.
 */
export function largeFileId(raw: string): LargeFileId {
  return raw as LargeFileId
}
