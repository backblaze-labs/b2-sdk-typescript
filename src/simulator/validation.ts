/**
 * B2 spec-compliance validation helpers for the simulator.
 *
 * Each function mirrors a documented B2 input limit (file name length,
 * bucket name regex, file-info byte budget, etc.). Validators return
 * `null` for valid input or a `{ code, message }` pair that the handler
 * converts into a synthetic `400`/`403` response with the right B2
 * error code.
 *
 * Keeping validation in one module makes the simulator's "what does B2
 * reject?" surface auditable in a single file. Doc references inline at
 * each rule so the spec source is immediate.
 *
 * @packageDocumentation
 */

import { utf8Encoder } from '../util/text-codec.ts'

/** Shape returned by validation functions when input is rejected. */
export interface ValidationError {
  readonly code: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Bucket name (`b2_create_bucket`, `b2_update_bucket`)
// ---------------------------------------------------------------------------

/** Minimum B2 bucket-name length per https://www.backblaze.com/apidocs/b2-create-bucket. */
export const BUCKET_NAME_MIN = 6
/** Maximum B2 bucket-name length per https://www.backblaze.com/apidocs/b2-create-bucket. */
export const BUCKET_NAME_MAX = 63
/** Bucket-name char set: letters, digits, hyphens. Anchored, leading/trailing hyphens are illegal. */
const BUCKET_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/
/** Reserved prefix — B2 forbids consumer-created buckets starting with `b2-`. */
const BUCKET_NAME_RESERVED_PREFIX = 'b2-'

/**
 * Validates a bucket name against B2's documented rules.
 *
 * @param name - Caller-supplied bucket name.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-create-bucket
 */
export function validateBucketName(name: string): ValidationError | null {
  if (typeof name !== 'string' || name.length < BUCKET_NAME_MIN || name.length > BUCKET_NAME_MAX) {
    return {
      code: 'invalid_bucket_name',
      message: `bucketName must be ${BUCKET_NAME_MIN}-${BUCKET_NAME_MAX} characters`,
    }
  }
  if (!BUCKET_NAME_REGEX.test(name)) {
    return {
      code: 'invalid_bucket_name',
      message:
        'bucketName must contain only letters, digits, and hyphens; cannot start or end with a hyphen',
    }
  }
  if (name.startsWith(BUCKET_NAME_RESERVED_PREFIX)) {
    return {
      code: 'invalid_bucket_name',
      message: `bucketName cannot start with the reserved prefix "${BUCKET_NAME_RESERVED_PREFIX}"`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// File name (every upload / hide / copy entry point)
// ---------------------------------------------------------------------------

/** Max file-name length is 1024 BYTES (UTF-8 encoded), not chars. */
export const FILE_NAME_MAX_BYTES = 1024
/** Control-character range B2 rejects: U+0000-U+001F (32 codepoints) plus DEL (U+007F). */
const FILE_NAME_DEL = 0x7f

/**
 * Validates a file name against B2's documented rules. Mirrors the
 * server-side checks B2 runs on `b2_upload_file` / `b2_hide_file` /
 * `b2_start_large_file` / `b2_copy_file` filename inputs.
 *
 * @param name - Caller-supplied file name (raw, unencoded).
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-upload-file
 */
export function validateFileName(name: string): ValidationError | null {
  if (typeof name !== 'string' || name.length === 0) {
    return { code: 'invalid_file_name', message: 'fileName must be a non-empty string' }
  }
  const bytes = utf8Encoder.encode(name)
  if (bytes.byteLength > FILE_NAME_MAX_BYTES) {
    return {
      code: 'invalid_file_name',
      message: `fileName exceeds the 1024-byte UTF-8 limit (got ${bytes.byteLength})`,
    }
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === FILE_NAME_DEL) {
      return {
        code: 'invalid_file_name',
        message: 'fileName must not contain control characters (U+0000-U+001F or U+007F)',
      }
    }
  }
  // Path segments equal to `.` or `..` alone are illegal per B2 docs.
  // Embedded `..` within a segment (e.g. `a..b`) is fine, and a path
  // like `../foo` is fine because the SDK doesn't interpret it; only
  // bare `.` or `..` as a complete name is rejected.
  if (name === '.' || name === '..') {
    return {
      code: 'invalid_file_name',
      message: 'fileName cannot be exactly "." or ".."',
    }
  }
  // No leading or trailing slash, no `//`.
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return {
      code: 'invalid_file_name',
      message: 'fileName cannot start with "/", end with "/", or contain "//"',
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// File-info / Bucket-info byte budget
// ---------------------------------------------------------------------------

/** Per-file fileInfo total size cap (sum of key+value bytes). */
export const FILE_INFO_TOTAL_MAX = 2048
/** Per-key fileInfo value byte cap. */
export const FILE_INFO_VALUE_MAX = 2048
/** Allowed key character set (case-insensitive). */
const FILE_INFO_KEY_REGEX = /^[a-zA-Z0-9_-]+$/

/**
 * Validates a `fileInfo` record against B2's byte-budget and
 * key-shape rules.
 *
 * @param info - Caller-supplied fileInfo record.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-upload-file
 */
export function validateFileInfo(info: Record<string, string>): ValidationError | null {
  let total = 0
  for (const [key, value] of Object.entries(info)) {
    if (!FILE_INFO_KEY_REGEX.test(key)) {
      return {
        code: 'invalid_file_info',
        message: `fileInfo key "${key}" must match ^[a-zA-Z0-9_-]+$`,
      }
    }
    if (typeof value !== 'string') {
      return { code: 'invalid_file_info', message: `fileInfo value for "${key}" must be a string` }
    }
    const keyBytes = utf8Encoder.encode(key).byteLength
    const valueBytes = utf8Encoder.encode(value).byteLength
    if (valueBytes > FILE_INFO_VALUE_MAX) {
      return {
        code: 'invalid_file_info',
        message: `fileInfo value for "${key}" exceeds ${FILE_INFO_VALUE_MAX} bytes`,
      }
    }
    total += keyBytes + valueBytes
  }
  if (total > FILE_INFO_TOTAL_MAX) {
    return {
      code: 'invalid_file_info',
      message: `fileInfo total size ${total} bytes exceeds the ${FILE_INFO_TOTAL_MAX}-byte limit`,
    }
  }
  return null
}

/** Per-bucket bucketInfo total max keys. */
export const BUCKET_INFO_MAX_KEYS = 10
/** Per-key bucketInfo value byte cap. */
export const BUCKET_INFO_VALUE_MAX = 2048
/** Allowed key character set for bucketInfo. */
const BUCKET_INFO_KEY_REGEX = /^[a-zA-Z0-9_-]+$/

/**
 * Validates a `bucketInfo` record against B2's per-bucket metadata rules.
 *
 * @param info - Caller-supplied bucketInfo record.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-create-bucket
 */
export function validateBucketInfo(info: Record<string, string>): ValidationError | null {
  const entries = Object.entries(info)
  if (entries.length > BUCKET_INFO_MAX_KEYS) {
    return {
      code: 'invalid_bucket_info',
      message: `bucketInfo cannot have more than ${BUCKET_INFO_MAX_KEYS} keys (got ${entries.length})`,
    }
  }
  for (const [key, value] of entries) {
    if (!BUCKET_INFO_KEY_REGEX.test(key)) {
      return {
        code: 'invalid_bucket_info',
        message: `bucketInfo key "${key}" must match ^[a-zA-Z0-9_-]+$`,
      }
    }
    if (typeof value !== 'string') {
      return {
        code: 'invalid_bucket_info',
        message: `bucketInfo value for "${key}" must be a string`,
      }
    }
    const valueBytes = utf8Encoder.encode(value).byteLength
    if (valueBytes > BUCKET_INFO_VALUE_MAX) {
      return {
        code: 'invalid_bucket_info',
        message: `bucketInfo value for "${key}" exceeds ${BUCKET_INFO_VALUE_MAX} bytes`,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// maxFileCount caps per endpoint
// ---------------------------------------------------------------------------

/**
 * Per-endpoint upper bound on the `maxFileCount` (or `maxKeyCount` /
 * `maxPartCount`) request field. Sourced from the B2 endpoint docs.
 */
export const LIST_ENDPOINT_CAPS = {
  /** `b2_list_file_names.maxFileCount` cap. */
  b2_list_file_names: 10_000,
  /** `b2_list_file_versions.maxFileCount` cap. */
  b2_list_file_versions: 10_000,
  /** `b2_list_unfinished_large_files.maxFileCount` cap. */
  b2_list_unfinished_large_files: 100,
  /** `b2_list_keys.maxKeyCount` cap. */
  b2_list_keys: 10_000,
  /** `b2_list_parts.maxPartCount` cap. */
  b2_list_parts: 10_000,
} as const

/**
 * Validates a `maxFileCount` (or `maxKeyCount` / `maxPartCount`) value
 * against the per-endpoint cap documented by B2.
 *
 * @param requested - Caller-supplied count.
 * @param endpoint - Which list endpoint this applies to.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 */
export function validateMaxCount(
  requested: number | undefined,
  endpoint: keyof typeof LIST_ENDPOINT_CAPS,
): ValidationError | null {
  if (requested === undefined) return null
  if (!Number.isInteger(requested) || requested < 1) {
    return {
      code: 'bad_request',
      message: `maxFileCount must be a positive integer (got ${requested})`,
    }
  }
  const cap = LIST_ENDPOINT_CAPS[endpoint]
  if (requested > cap) {
    return {
      code: 'bad_request',
      message: `maxFileCount ${requested} exceeds the ${endpoint} cap of ${cap}`,
    }
  }
  return null
}
