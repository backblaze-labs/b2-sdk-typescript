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

import {
  BUCKET_NAME_MAX,
  BUCKET_NAME_MIN,
  BUCKET_NAME_RESERVED_PREFIX,
  FILE_NAME_MAX_BYTES,
  getB2FileNameByteLength,
  hasB2FileNameControlCharacter,
  hasValidB2BucketNameShape,
  isB2BucketNameIpv4Address,
} from '../internal/b2-naming.ts'
import { Capability } from '../types/auth.ts'
import { BucketRetentionMode, BucketType, CorsOperation } from '../types/bucket.ts'
import { EventType } from '../types/notifications.ts'
import { utf8Encoder } from '../util/text-codec.ts'

/** Shape returned by validation functions when input is rejected. */
export interface ValidationError {
  readonly code: string
  readonly message: string
}

// ---------------------------------------------------------------------------
// Application keys (`b2_create_key`)
// ---------------------------------------------------------------------------

/** Minimum length for application key names. */
export const KEY_NAME_MIN = 1
/** Maximum length for application key names. */
export const KEY_NAME_MAX = 100

const VALID_CAPABILITIES = new Set<string>(Object.values(Capability))

/**
 * Validates application-key capabilities against B2's supported capability set.
 *
 * @param capabilities - Caller-supplied capabilities array.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-create-key
 */
export function validateCreateKeyCapabilities(capabilities: unknown): ValidationError | null {
  if (!Array.isArray(capabilities)) {
    return { code: 'bad_request', message: 'capabilities must be an array' }
  }
  if (capabilities.length === 0) {
    return { code: 'bad_request', message: 'capabilities must not be empty' }
  }
  const unknownCapabilities = capabilities.filter(
    (capability) => typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability),
  )
  if (unknownCapabilities.length > 0) {
    return {
      code: 'bad_request',
      message: `unknown capabilities: ${unknownCapabilities.map(String).join(', ')}`,
    }
  }
  return null
}

/**
 * Returns a frozen copy of a previously validated application-key capability list.
 *
 * @param capabilities - Validated caller-supplied capabilities.
 *
 * @returns An immutable capability list safe to store internally.
 */
export function normalizeCreateKeyCapabilities(
  capabilities: readonly Capability[],
): readonly Capability[] {
  return Object.freeze([...capabilities])
}

/**
 * Validates application-key names against B2's documented length limits.
 *
 * @param keyName - Caller-supplied keyName.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-create-key
 */
export function validateCreateKeyName(keyName: unknown): ValidationError | null {
  if (typeof keyName !== 'string') {
    return { code: 'bad_request', message: 'keyName must be a string' }
  }
  if (keyName.length < KEY_NAME_MIN || keyName.length > KEY_NAME_MAX) {
    return {
      code: 'bad_request',
      message: `keyName must be ${KEY_NAME_MIN}-${KEY_NAME_MAX} characters`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Bucket name (`b2_create_bucket`, `b2_update_bucket`)
// ---------------------------------------------------------------------------

export { BUCKET_NAME_MAX, BUCKET_NAME_MIN }

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
  if (isB2BucketNameIpv4Address(name)) {
    return {
      code: 'invalid_bucket_name',
      message: 'bucketName must not be formatted as an IPv4 address',
    }
  }
  if (!hasValidB2BucketNameShape(name)) {
    return {
      code: 'invalid_bucket_name',
      message:
        'bucketName must contain only letters, digits, hyphens, and periods; cannot start or end with punctuation or contain consecutive periods',
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

export { FILE_NAME_MAX_BYTES }

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
  const byteLength = getB2FileNameByteLength(name)
  if (byteLength === null) {
    return {
      code: 'invalid_file_name',
      message: 'fileName exceeds the 1024-byte UTF-8 limit',
    }
  }
  if (hasB2FileNameControlCharacter(name)) {
    return {
      code: 'invalid_file_name',
      message: 'fileName must not contain control characters (U+0000-U+001F or U+007F)',
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

// ---------------------------------------------------------------------------
// Download authorization duration
// ---------------------------------------------------------------------------

/** Minimum `b2_get_download_authorization.validDurationInSeconds`. */
export const DOWNLOAD_AUTH_DURATION_MIN_SECONDS = 1
/** Maximum `b2_get_download_authorization.validDurationInSeconds`. */
export const DOWNLOAD_AUTH_DURATION_MAX_SECONDS = 604_800

/**
 * Validates a `b2_get_download_authorization` duration against B2's
 * documented inclusive 1-second to 7-day range.
 *
 * @param requested - Caller-supplied duration in seconds.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 */
export function validateDownloadAuthorizationDuration(requested: unknown): ValidationError | null {
  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested < DOWNLOAD_AUTH_DURATION_MIN_SECONDS ||
    requested > DOWNLOAD_AUTH_DURATION_MAX_SECONDS
  ) {
    return {
      code: 'bad_request',
      message: `validDurationInSeconds must be an integer from ${DOWNLOAD_AUTH_DURATION_MIN_SECONDS} through ${DOWNLOAD_AUTH_DURATION_MAX_SECONDS}`,
    }
  }
  return null
}

/**
 * Validates a `b2_get_download_authorization` file name prefix.
 *
 * B2 allows an empty prefix, but the field must still be present as a
 * string so later prefix checks cannot crash on malformed request bodies.
 *
 * @param requested - Caller-supplied file name prefix.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 */
export function validateDownloadAuthorizationPrefix(requested: unknown): ValidationError | null {
  if (typeof requested !== 'string') {
    return { code: 'bad_request', message: 'fileNamePrefix must be a string' }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateKnownFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  path: string,
): ValidationError | null {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      return {
        code: 'bad_request',
        message: `${path}.${field} is not a supported field`,
      }
    }
  }
  return null
}

function validateStringArray(
  value: unknown,
  path: string,
  options: { readonly allowNull?: boolean; readonly requireNonEmpty?: boolean } = {},
): ValidationError | null {
  if (value === null && options.allowNull === true) return null
  if (!Array.isArray(value)) {
    return { code: 'bad_request', message: `${path} must be an array of strings` }
  }
  if (options.requireNonEmpty === true && value.length === 0) {
    return { code: 'bad_request', message: `${path} must be a non-empty array` }
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      return { code: 'bad_request', message: `${path}[${index}] must be a string` }
    }
  }
  return null
}

function validateNonEmptyString(value: unknown, path: string): ValidationError | null {
  if (typeof value !== 'string' || value.length === 0) {
    return { code: 'bad_request', message: `${path} must be a non-empty string` }
  }
  return null
}

function validateNonNegativeInteger(value: unknown, path: string): ValidationError | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { code: 'bad_request', message: `${path} must be a non-negative integer` }
  }
  return null
}

function validateIntegerAtMost(value: number, max: number, path: string): ValidationError | null {
  if (value > max) {
    return { code: 'bad_request', message: `${path} must not exceed ${max}` }
  }
  return null
}

function validatePositiveInteger(value: unknown, path: string): ValidationError | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { code: 'bad_request', message: `${path} must be a positive integer` }
  }
  return null
}

function validateNullablePositiveInteger(value: unknown, path: string): ValidationError | null {
  if (value === undefined || value === null) return null
  return validatePositiveInteger(value, path)
}

function validateUniqueName(
  names: Set<string>,
  name: string,
  path: string,
): ValidationError | null {
  if (names.has(name)) {
    return { code: 'bad_request', message: `${path} must be unique` }
  }
  names.add(name)
  return null
}

// ---------------------------------------------------------------------------
// Bucket configuration (`b2_create_bucket`, `b2_update_bucket`)
// ---------------------------------------------------------------------------

const REQUEST_BUCKET_TYPES = new Set<string>([
  BucketType.AllPublic,
  BucketType.AllPrivate,
  BucketType.Snapshot,
  BucketType.Restricted,
])

/**
 * Validates a `b2_list_buckets.bucketTypes` filter.
 *
 * @param bucketTypes - Caller-supplied bucket type filter.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-list-buckets
 */
export function validateBucketTypes(bucketTypes: unknown): ValidationError | null {
  if (bucketTypes === undefined) return null
  if (!Array.isArray(bucketTypes)) {
    return { code: 'bad_request', message: 'bucketTypes must be an array' }
  }
  for (const [index, bucketType] of bucketTypes.entries()) {
    if (typeof bucketType !== 'string' || !REQUEST_BUCKET_TYPES.has(bucketType)) {
      return {
        code: 'bad_request',
        message: `bucketTypes[${index}] must be a known bucket type`,
      }
    }
  }
  return null
}

const CORS_RULE_FIELDS = new Set([
  'allowedHeaders',
  'allowedOperations',
  'allowedOrigins',
  'corsRuleName',
  'exposeHeaders',
  'maxAgeSeconds',
])

const CORS_MAX_AGE_SECONDS_MAX = 86_400
const KNOWN_CORS_OPERATIONS = new Set<string>(Object.values(CorsOperation))

/**
 * Validates B2 CORS rule structure for bucket create/update requests.
 *
 * @param rules - Caller-supplied CORS rules.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules
 */
export function validateCorsRules(rules: unknown): ValidationError | null {
  if (!Array.isArray(rules)) {
    return { code: 'bad_request', message: 'corsRules must be an array' }
  }

  const names = new Set<string>()
  for (const [index, rule] of rules.entries()) {
    const rulePath = `corsRules[${index}]`
    if (!isRecord(rule)) {
      return { code: 'bad_request', message: `${rulePath} must be an object` }
    }

    const fieldError = validateKnownFields(rule, CORS_RULE_FIELDS, rulePath)
    if (fieldError) return fieldError

    const nameError = validateNonEmptyString(rule['corsRuleName'], `${rulePath}.corsRuleName`)
    if (nameError) return nameError
    const ruleName = rule['corsRuleName'] as string
    const uniqueNameError = validateUniqueName(names, ruleName, `${rulePath}.corsRuleName`)
    if (uniqueNameError) return uniqueNameError

    const originsError = validateStringArray(rule['allowedOrigins'], `${rulePath}.allowedOrigins`, {
      requireNonEmpty: true,
    })
    if (originsError) return originsError

    const operationsError = validateStringArray(
      rule['allowedOperations'],
      `${rulePath}.allowedOperations`,
      { requireNonEmpty: true },
    )
    if (operationsError) return operationsError
    for (const operation of rule['allowedOperations'] as readonly string[]) {
      if (!KNOWN_CORS_OPERATIONS.has(operation)) {
        return {
          code: 'bad_request',
          message: `${rulePath}.allowedOperations contains an unknown operation`,
        }
      }
    }

    const headersError = validateStringArray(rule['allowedHeaders'], `${rulePath}.allowedHeaders`, {
      allowNull: true,
    })
    if (headersError) return headersError

    const exposeError = validateStringArray(rule['exposeHeaders'], `${rulePath}.exposeHeaders`, {
      allowNull: true,
    })
    if (exposeError) return exposeError

    const ageError = validateNonNegativeInteger(rule['maxAgeSeconds'], `${rulePath}.maxAgeSeconds`)
    if (ageError) return ageError
    const maxAgeError = validateIntegerAtMost(
      rule['maxAgeSeconds'] as number,
      CORS_MAX_AGE_SECONDS_MAX,
      `${rulePath}.maxAgeSeconds`,
    )
    if (maxAgeError) return maxAgeError
  }

  return null
}

const LIFECYCLE_RULE_FIELDS = new Set([
  'daysFromHidingToDeleting',
  'daysFromStartingToCancelingUnfinishedLargeFiles',
  'daysFromUploadingToHiding',
  'fileNamePrefix',
])

/**
 * Validates B2 lifecycle rule structure for bucket create/update requests.
 *
 * @param rules - Caller-supplied lifecycle rules.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/docs/cloud-storage-lifecycle-rules
 */
export function validateLifecycleRules(rules: unknown): ValidationError | null {
  if (!Array.isArray(rules)) {
    return { code: 'bad_request', message: 'lifecycleRules must be an array' }
  }

  for (const [index, rule] of rules.entries()) {
    const rulePath = `lifecycleRules[${index}]`
    if (!isRecord(rule)) {
      return { code: 'bad_request', message: `${rulePath} must be an object` }
    }

    const fieldError = validateKnownFields(rule, LIFECYCLE_RULE_FIELDS, rulePath)
    if (fieldError) return fieldError

    const deletingError = validateNullablePositiveInteger(
      rule['daysFromHidingToDeleting'],
      `${rulePath}.daysFromHidingToDeleting`,
    )
    if (deletingError) return deletingError

    const hidingError = validateNullablePositiveInteger(
      rule['daysFromUploadingToHiding'],
      `${rulePath}.daysFromUploadingToHiding`,
    )
    if (hidingError) return hidingError

    const cancelError = validateNullablePositiveInteger(
      rule['daysFromStartingToCancelingUnfinishedLargeFiles'],
      `${rulePath}.daysFromStartingToCancelingUnfinishedLargeFiles`,
    )
    if (cancelError) return cancelError

    if (
      rule['daysFromHidingToDeleting'] == null &&
      rule['daysFromUploadingToHiding'] == null &&
      rule['daysFromStartingToCancelingUnfinishedLargeFiles'] == null
    ) {
      return {
        code: 'bad_request',
        message: `${rulePath} must set at least one lifecycle action`,
      }
    }

    if (typeof rule['fileNamePrefix'] !== 'string') {
      return { code: 'bad_request', message: `${rulePath}.fileNamePrefix must be a string` }
    }
  }

  return null
}

const DEFAULT_RETENTION_FIELDS = new Set(['mode', 'period'])
const RETENTION_PERIOD_FIELDS = new Set(['duration', 'unit'])
const DEFAULT_RETENTION_MODES = new Set<string>(Object.values(BucketRetentionMode))
const OBJECT_LOCK_RETENTION_MAX_DAYS = 3000

/**
 * Validates default Object Lock retention policy structure for bucket requests.
 *
 * @param policy - Caller-supplied default retention policy.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/docs/cloud-storage-object-lock
 */
export function validateDefaultRetention(policy: unknown): ValidationError | null {
  if (!isRecord(policy)) {
    return { code: 'bad_request', message: 'defaultRetention must be an object' }
  }

  const fieldError = validateKnownFields(policy, DEFAULT_RETENTION_FIELDS, 'defaultRetention')
  if (fieldError) return fieldError

  const mode = policy['mode']
  if (typeof mode !== 'string' || !DEFAULT_RETENTION_MODES.has(mode)) {
    return {
      code: 'bad_request',
      message: 'defaultRetention.mode must be "compliance", "governance", or "none"',
    }
  }

  const period = policy['period']
  if (mode === BucketRetentionMode.None) {
    if (period !== null) {
      return {
        code: 'bad_request',
        message: 'defaultRetention.period must be null when mode is "none"',
      }
    }
    return null
  }

  if (!isRecord(period)) {
    return {
      code: 'bad_request',
      message: 'defaultRetention.period must be an object for retention modes',
    }
  }

  const periodFieldError = validateKnownFields(
    period,
    RETENTION_PERIOD_FIELDS,
    'defaultRetention.period',
  )
  if (periodFieldError) return periodFieldError

  const durationError = validatePositiveInteger(
    period['duration'],
    'defaultRetention.period.duration',
  )
  if (durationError) return durationError
  if (!Number.isSafeInteger(period['duration'])) {
    return {
      code: 'bad_request',
      message: 'defaultRetention.period.duration must be a safe integer',
    }
  }

  if (period['unit'] !== 'days' && period['unit'] !== 'years') {
    return {
      code: 'bad_request',
      message: 'defaultRetention.period.unit must be "days" or "years"',
    }
  }
  const durationDays =
    period['unit'] === 'days'
      ? (period['duration'] as number)
      : (period['duration'] as number) * 365
  if (!Number.isFinite(durationDays) || durationDays > OBJECT_LOCK_RETENTION_MAX_DAYS) {
    return {
      code: 'bad_request',
      message: `defaultRetention.period must not exceed ${OBJECT_LOCK_RETENTION_MAX_DAYS} days`,
    }
  }

  return null
}

const REPLICATION_CONFIG_FIELDS = new Set(['asReplicationSource', 'asReplicationDestination'])
const REPLICATION_SOURCE_FIELDS = new Set(['replicationRules', 'sourceApplicationKeyId'])
const REPLICATION_DESTINATION_FIELDS = new Set(['sourceToDestinationKeyMapping'])
const REPLICATION_RULE_FIELDS = new Set([
  'destinationBucketId',
  'fileNamePrefix',
  'includeExistingFiles',
  'isEnabled',
  'priority',
  'replicationRuleName',
])

function validateReplicationRule(rule: unknown, rulePath: string): ValidationError | null {
  if (!isRecord(rule)) {
    return { code: 'bad_request', message: `${rulePath} must be an object` }
  }

  const fieldError = validateKnownFields(rule, REPLICATION_RULE_FIELDS, rulePath)
  if (fieldError) return fieldError

  const destinationError = validateNonEmptyString(
    rule['destinationBucketId'],
    `${rulePath}.destinationBucketId`,
  )
  if (destinationError) return destinationError

  if (typeof rule['fileNamePrefix'] !== 'string') {
    return { code: 'bad_request', message: `${rulePath}.fileNamePrefix must be a string` }
  }

  if (typeof rule['includeExistingFiles'] !== 'boolean') {
    return { code: 'bad_request', message: `${rulePath}.includeExistingFiles must be a boolean` }
  }

  if (typeof rule['isEnabled'] !== 'boolean') {
    return { code: 'bad_request', message: `${rulePath}.isEnabled must be a boolean` }
  }

  const priorityError = validatePositiveInteger(rule['priority'], `${rulePath}.priority`)
  if (priorityError) return priorityError

  const nameError = validateNonEmptyString(
    rule['replicationRuleName'],
    `${rulePath}.replicationRuleName`,
  )
  if (nameError) return nameError

  return null
}

function validateReplicationSource(source: unknown): ValidationError | null {
  if (!isRecord(source)) {
    return {
      code: 'bad_request',
      message: 'replicationConfiguration.asReplicationSource must be an object',
    }
  }

  const fieldError = validateKnownFields(
    source,
    REPLICATION_SOURCE_FIELDS,
    'replicationConfiguration.asReplicationSource',
  )
  if (fieldError) return fieldError

  const sourceKeyError = validateNonEmptyString(
    source['sourceApplicationKeyId'],
    'replicationConfiguration.asReplicationSource.sourceApplicationKeyId',
  )
  if (sourceKeyError) return sourceKeyError

  const rules = source['replicationRules']
  if (!Array.isArray(rules)) {
    return {
      code: 'bad_request',
      message: 'replicationConfiguration.asReplicationSource.replicationRules must be an array',
    }
  }

  const names = new Set<string>()
  for (const [index, rule] of rules.entries()) {
    const rulePath = `replicationConfiguration.asReplicationSource.replicationRules[${index}]`
    const ruleError = validateReplicationRule(rule, rulePath)
    if (ruleError) return ruleError
    const ruleName = (rule as Record<string, unknown>)['replicationRuleName'] as string
    const uniqueNameError = validateUniqueName(names, ruleName, `${rulePath}.replicationRuleName`)
    if (uniqueNameError) return uniqueNameError
  }

  return null
}

function validateReplicationDestination(destination: unknown): ValidationError | null {
  if (!isRecord(destination)) {
    return {
      code: 'bad_request',
      message: 'replicationConfiguration.asReplicationDestination must be an object',
    }
  }

  const fieldError = validateKnownFields(
    destination,
    REPLICATION_DESTINATION_FIELDS,
    'replicationConfiguration.asReplicationDestination',
  )
  if (fieldError) return fieldError

  const mapping = destination['sourceToDestinationKeyMapping']
  if (!isRecord(mapping)) {
    return {
      code: 'bad_request',
      message:
        'replicationConfiguration.asReplicationDestination.sourceToDestinationKeyMapping must be an object',
    }
  }

  for (const [sourceKey, destinationKey] of Object.entries(mapping)) {
    if (sourceKey.length === 0) {
      return {
        code: 'bad_request',
        message:
          'replicationConfiguration.asReplicationDestination.sourceToDestinationKeyMapping keys must be non-empty',
      }
    }
    if (typeof destinationKey !== 'string' || destinationKey.length === 0) {
      return {
        code: 'bad_request',
        message:
          'replicationConfiguration.asReplicationDestination.sourceToDestinationKeyMapping values must be non-empty strings',
      }
    }
  }

  return null
}

/**
 * Validates B2 replication configuration structure for bucket requests.
 *
 * @param config - Caller-supplied replication configuration.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-update-bucket
 */
export function validateReplicationConfiguration(config: unknown): ValidationError | null {
  if (!isRecord(config)) {
    return { code: 'bad_request', message: 'replicationConfiguration must be an object' }
  }

  const fieldError = validateKnownFields(
    config,
    REPLICATION_CONFIG_FIELDS,
    'replicationConfiguration',
  )
  if (fieldError) return fieldError

  if (!('asReplicationSource' in config) && !('asReplicationDestination' in config)) {
    return {
      code: 'bad_request',
      message:
        'replicationConfiguration must include asReplicationSource or asReplicationDestination',
    }
  }

  const source = config['asReplicationSource']
  if (source !== undefined && source !== null) {
    const sourceError = validateReplicationSource(source)
    if (sourceError) return sourceError
  }

  const destination = config['asReplicationDestination']
  if (destination !== undefined && destination !== null) {
    const destinationError = validateReplicationDestination(destination)
    if (destinationError) return destinationError
  }

  return null
}

// ---------------------------------------------------------------------------
// Event notification rules (`b2_set_bucket_notification_rules`)
// ---------------------------------------------------------------------------

const NOTIFICATION_RULE_FIELDS = new Set([
  'eventTypes',
  'isEnabled',
  'isSuspended',
  'maxEventsPerBatch',
  'name',
  'objectNamePrefix',
  'suspensionReason',
  'targetConfiguration',
])

const NOTIFICATION_TARGET_FIELDS = new Set([
  'customHeaders',
  'hmacSha256SigningSecret',
  'targetType',
  'url',
])

const NOTIFICATION_CUSTOM_HEADER_FIELDS = new Set(['name', 'value'])
const NOTIFICATION_CUSTOM_HEADER_MAX_COUNT = 10
const NOTIFICATION_CUSTOM_HEADER_MAX_ENCODED_BYTES = 2048
const NOTIFICATION_CUSTOM_HEADER_RESERVED_PREFIX = 'x-bz-'
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const KNOWN_NOTIFICATION_EVENT_TYPES = new Set<string>(Object.values(EventType))

function encodedHeaderBytes(name: string, value: string): number | null {
  try {
    // B2 counts the URL-encoded name/value plus the `:\r\n` separator per header.
    return encodeURIComponent(name).length + encodeURIComponent(value).length + 3
  } catch {
    return null
  }
}

function isValidHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 9) continue
    if (code < 32 || code === 127) return false
  }
  return true
}

function validateNotificationCustomHeaders(value: unknown, path: string): ValidationError | null {
  if (value === undefined) return null
  if (!Array.isArray(value)) {
    return { code: 'bad_request', message: `${path} must be an array of objects` }
  }
  if (value.length > NOTIFICATION_CUSTOM_HEADER_MAX_COUNT) {
    return {
      code: 'bad_request',
      message: `${path} must contain no more than ${NOTIFICATION_CUSTOM_HEADER_MAX_COUNT} entries`,
    }
  }

  const names = new Set<string>()
  let encodedBytes = 0
  for (const [index, header] of value.entries()) {
    const headerPath = `${path}[${index}]`
    if (!isRecord(header)) {
      return { code: 'bad_request', message: `${headerPath} must be an object` }
    }
    const fieldError = validateKnownFields(header, NOTIFICATION_CUSTOM_HEADER_FIELDS, headerPath)
    if (fieldError) return fieldError
    if (typeof header['name'] !== 'string' || header['name'].length === 0) {
      return { code: 'bad_request', message: `${headerPath}.name must be a non-empty string` }
    }
    if (typeof header['value'] !== 'string') {
      return { code: 'bad_request', message: `${headerPath}.value must be a string` }
    }

    const name = header['name']
    const normalizedName = name.toLowerCase()
    if (!HTTP_HEADER_NAME_RE.test(name)) {
      return { code: 'bad_request', message: `${headerPath}.name must be a valid HTTP header name` }
    }
    if (normalizedName.startsWith(NOTIFICATION_CUSTOM_HEADER_RESERVED_PREFIX)) {
      return {
        code: 'bad_request',
        message: `${headerPath}.name must not begin with X-Bz-`,
      }
    }
    if (names.has(normalizedName)) {
      return { code: 'bad_request', message: `${headerPath}.name must be unique` }
    }
    names.add(normalizedName)

    const headerValue = header['value']
    if (!isValidHeaderValue(headerValue)) {
      return {
        code: 'bad_request',
        message: `${headerPath}.value must be a valid HTTP header value`,
      }
    }

    const size = encodedHeaderBytes(name, headerValue)
    if (size === null) {
      return { code: 'bad_request', message: `${headerPath} must be URL-encodable` }
    }
    encodedBytes += size
    if (encodedBytes > NOTIFICATION_CUSTOM_HEADER_MAX_ENCODED_BYTES) {
      return {
        code: 'bad_request',
        message: `${path} URL-encoded name/value bytes must not exceed ${NOTIFICATION_CUSTOM_HEADER_MAX_ENCODED_BYTES}`,
      }
    }
  }
  return null
}

/**
 * Validates event notification rules for `b2_set_bucket_notification_rules`.
 *
 * @param rules - Caller-supplied event notification rules.
 *
 * @returns A `{ code, message }` pair on failure, or `null` when valid.
 *
 * @see https://www.backblaze.com/apidocs/b2-set-bucket-notification-rules
 */
export function validateNotificationRules(rules: unknown): ValidationError | null {
  if (!Array.isArray(rules)) {
    return {
      code: 'bad_request',
      message: 'eventNotificationRules must be an array',
    }
  }

  const names = new Set<string>()
  for (const [index, ruleValue] of rules.entries()) {
    const rulePath = `eventNotificationRules[${index}]`
    if (!isRecord(ruleValue)) {
      return { code: 'bad_request', message: `${rulePath} must be an object` }
    }

    const fieldError = validateKnownFields(ruleValue, NOTIFICATION_RULE_FIELDS, rulePath)
    if (fieldError) return fieldError

    if (typeof ruleValue['isEnabled'] !== 'boolean') {
      return {
        code: 'bad_request',
        message: `${rulePath}.isEnabled must be a boolean`,
      }
    }

    const maxEventsPerBatch = ruleValue['maxEventsPerBatch']
    if (
      maxEventsPerBatch !== undefined &&
      (typeof maxEventsPerBatch !== 'number' ||
        !Number.isInteger(maxEventsPerBatch) ||
        maxEventsPerBatch < 1)
    ) {
      return {
        code: 'bad_request',
        message: `${rulePath}.maxEventsPerBatch must be a positive integer`,
      }
    }

    const name = ruleValue['name']
    if (typeof name !== 'string' || name.length === 0) {
      return {
        code: 'bad_request',
        message: `${rulePath}.name must be a non-empty string`,
      }
    }
    if (names.has(name)) {
      return {
        code: 'bad_request',
        message: `${rulePath}.name must be unique within eventNotificationRules`,
      }
    }
    names.add(name)

    const eventTypes = ruleValue['eventTypes']
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      return {
        code: 'bad_request',
        message: `${rulePath}.eventTypes must be a non-empty array`,
      }
    }
    for (const eventType of eventTypes) {
      if (typeof eventType !== 'string' || !KNOWN_NOTIFICATION_EVENT_TYPES.has(eventType)) {
        return {
          code: 'bad_request',
          message: `${rulePath}.eventTypes contains an unknown event type`,
        }
      }
    }

    const targetConfiguration = ruleValue['targetConfiguration']
    if (!isRecord(targetConfiguration)) {
      return {
        code: 'bad_request',
        message: `${rulePath}.targetConfiguration must be an object`,
      }
    }

    const targetFieldError = validateKnownFields(
      targetConfiguration,
      NOTIFICATION_TARGET_FIELDS,
      `${rulePath}.targetConfiguration`,
    )
    if (targetFieldError) return targetFieldError

    if (targetConfiguration['targetType'] !== 'webhook') {
      return {
        code: 'bad_request',
        message: `${rulePath}.targetConfiguration.targetType must be "webhook"`,
      }
    }

    const url = targetConfiguration['url']
    if (typeof url !== 'string') {
      return {
        code: 'bad_request',
        message: `${rulePath}.targetConfiguration.url must be a valid https URL`,
      }
    }
    try {
      if (new URL(url).protocol !== 'https:') {
        return {
          code: 'bad_request',
          message: `${rulePath}.targetConfiguration.url must be a valid https URL`,
        }
      }
    } catch {
      return {
        code: 'bad_request',
        message: `${rulePath}.targetConfiguration.url must be a valid https URL`,
      }
    }

    const customHeadersError = validateNotificationCustomHeaders(
      targetConfiguration['customHeaders'],
      `${rulePath}.targetConfiguration.customHeaders`,
    )
    if (customHeadersError) return customHeadersError
  }

  return null
}
