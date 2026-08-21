import { B2BucketConfigurationError } from './errors/index.ts'
import {
  BUCKET_INFO_KEY_MAX_BYTES,
  BUCKET_INFO_KEY_MIN_BYTES,
  BUCKET_INFO_RESERVED_PREFIX,
  BUCKET_INFO_VALUES_MAX_BYTES,
  CORS_ALLOWED_OPERATIONS,
  CORS_RULE_MAX_BYTES,
  CORS_RULE_NAME_MAX_LENGTH,
  CORS_RULE_NAME_MIN_LENGTH,
  CORS_RULE_NAME_PATTERN,
  CORS_RULE_NAME_RESERVED_PREFIX,
  CORS_RULES_MAX_COUNT,
  type CorsRule,
  type CreateBucketRequest,
  type UpdateBucketRequest,
} from './types/bucket.ts'
import { utf8Encoder } from './util/text-codec.ts'

const CORS_RULE_NAME_REGEX = new RegExp(CORS_RULE_NAME_PATTERN)
const CORS_OPERATION_SET = new Set<string>(CORS_ALLOWED_OPERATIONS)

/**
 * Validates a bucketInfo record against B2's documented bucket metadata limits.
 *
 * @param bucketInfo - Caller-supplied bucketInfo record.
 *
 * @throws {@link B2BucketConfigurationError} When the record violates B2 limits.
 */
export function assertValidBucketInfo(bucketInfo: Record<string, string>): void {
  if (!isObjectRecord(bucketInfo)) {
    throw new B2BucketConfigurationError(
      'bucketInfo',
      'bucketInfo must be an object',
      'invalid_bucket_info',
    )
  }

  let totalValueBytes = 0
  for (const [key, value] of Object.entries(bucketInfo)) {
    const keyBytes = utf8ByteLength(key)
    if (keyBytes < BUCKET_INFO_KEY_MIN_BYTES || keyBytes > BUCKET_INFO_KEY_MAX_BYTES) {
      throw new B2BucketConfigurationError(
        'bucketInfo',
        `bucketInfo key "${key}" must be ${BUCKET_INFO_KEY_MIN_BYTES}-${BUCKET_INFO_KEY_MAX_BYTES} UTF-8 bytes`,
        'invalid_bucket_info',
      )
    }
    if (key.startsWith(BUCKET_INFO_RESERVED_PREFIX)) {
      throw new B2BucketConfigurationError(
        'bucketInfo',
        `bucketInfo key "${key}" must not start with reserved prefix "${BUCKET_INFO_RESERVED_PREFIX}"`,
        'invalid_bucket_info',
      )
    }
    if (typeof value !== 'string') {
      throw new B2BucketConfigurationError(
        'bucketInfo',
        `bucketInfo value for "${key}" must be a string`,
        'invalid_bucket_info',
      )
    }

    totalValueBytes += utf8ByteLength(value)
    if (totalValueBytes > BUCKET_INFO_VALUES_MAX_BYTES) {
      throw new B2BucketConfigurationError(
        'bucketInfo',
        `bucketInfo values total ${totalValueBytes} UTF-8 bytes exceeds the ${BUCKET_INFO_VALUES_MAX_BYTES}-byte limit`,
        'invalid_bucket_info',
      )
    }
  }
}

/**
 * Validates CORS rules against B2's documented bucket CORS limits.
 *
 * @param corsRules - Caller-supplied CORS rule list.
 *
 * @throws {@link B2BucketConfigurationError} When any rule violates B2 limits.
 */
export function assertValidCorsRules(corsRules: readonly CorsRule[]): void {
  if (!Array.isArray(corsRules)) {
    throw new B2BucketConfigurationError('corsRules', 'corsRules must be an array')
  }
  if (corsRules.length > CORS_RULES_MAX_COUNT) {
    throw new B2BucketConfigurationError(
      'corsRules',
      `corsRules cannot have more than ${CORS_RULES_MAX_COUNT} rules (got ${corsRules.length})`,
    )
  }

  const names = new Set<string>()
  for (const [index, rule] of corsRules.entries()) {
    const rulePath = `corsRules[${index}]`
    if (!isObjectRecord(rule)) {
      throw new B2BucketConfigurationError('corsRules', `${rulePath} must be an object`)
    }

    const ruleName = readRequiredString(rule, 'corsRuleName', `${rulePath}.corsRuleName`)
    if (
      ruleName.length < CORS_RULE_NAME_MIN_LENGTH ||
      ruleName.length > CORS_RULE_NAME_MAX_LENGTH
    ) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.corsRuleName must be ${CORS_RULE_NAME_MIN_LENGTH}-${CORS_RULE_NAME_MAX_LENGTH} characters`,
      )
    }
    if (!CORS_RULE_NAME_REGEX.test(ruleName)) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.corsRuleName must match ${CORS_RULE_NAME_PATTERN}`,
      )
    }
    if (ruleName.startsWith(CORS_RULE_NAME_RESERVED_PREFIX)) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.corsRuleName must not start with reserved prefix "${CORS_RULE_NAME_RESERVED_PREFIX}"`,
      )
    }
    if (names.has(ruleName)) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.corsRuleName must be unique within the bucket`,
      )
    }
    names.add(ruleName)

    const allowedOrigins = readRequiredStringArray(
      rule,
      'allowedOrigins',
      `${rulePath}.allowedOrigins`,
    )
    if (allowedOrigins.length === 0) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.allowedOrigins must contain at least one item`,
      )
    }

    const allowedOperations = readRequiredStringArray(
      rule,
      'allowedOperations',
      `${rulePath}.allowedOperations`,
    )
    if (allowedOperations.length === 0) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.allowedOperations must contain at least one item`,
      )
    }
    for (const operation of allowedOperations) {
      if (!CORS_OPERATION_SET.has(operation)) {
        throw new B2BucketConfigurationError(
          'corsRules',
          `${rulePath}.allowedOperations contains unsupported operation "${operation}"`,
        )
      }
    }

    const allowedHeaders = readNullableStringArray(
      rule,
      'allowedHeaders',
      `${rulePath}.allowedHeaders`,
    )
    const exposeHeaders = readNullableStringArray(
      rule,
      'exposeHeaders',
      `${rulePath}.exposeHeaders`,
    )
    const maxAgeSeconds = (rule as Record<string, unknown>)['maxAgeSeconds']
    if (!Number.isSafeInteger(maxAgeSeconds) || (maxAgeSeconds as number) < 0) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath}.maxAgeSeconds must be a non-negative safe integer`,
      )
    }

    const ruleBytes =
      utf8ByteLength(ruleName) +
      sumStringBytes(allowedOrigins) +
      sumStringBytes(allowedOperations) +
      sumStringBytes(allowedHeaders ?? []) +
      sumStringBytes(exposeHeaders ?? [])
    if (ruleBytes >= CORS_RULE_MAX_BYTES) {
      throw new B2BucketConfigurationError(
        'corsRules',
        `${rulePath} size ${ruleBytes} UTF-8 bytes must be less than ${CORS_RULE_MAX_BYTES} bytes`,
      )
    }
  }
}

/**
 * Validates the bucket configuration fields common to create and update calls.
 *
 * @param request - Bucket create/update request.
 *
 * @throws {@link B2BucketConfigurationError} When any provided bucketInfo or
 * CORS field violates B2 limits.
 */
export function assertValidBucketConfiguration(
  request: Pick<CreateBucketRequest | UpdateBucketRequest, 'bucketInfo' | 'corsRules'>,
): void {
  if (request.bucketInfo !== undefined) assertValidBucketInfo(request.bucketInfo)
  if (request.corsRules !== undefined) assertValidCorsRules(request.corsRules)
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new B2BucketConfigurationError('corsRules', `${path} must be a string`)
  }
  return value
}

function readRequiredStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new B2BucketConfigurationError('corsRules', `${path} must be an array`)
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new B2BucketConfigurationError('corsRules', `${path}[${index}] must be a string`)
    }
  }
  return value
}

function readNullableStringArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
): readonly string[] | null {
  const value = record[key]
  if (value === null) return null
  if (!Array.isArray(value)) {
    throw new B2BucketConfigurationError('corsRules', `${path} must be an array or null`)
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new B2BucketConfigurationError('corsRules', `${path}[${index}] must be a string`)
    }
  }
  return value
}

function sumStringBytes(values: readonly string[]): number {
  let total = 0
  for (const value of values) total += utf8ByteLength(value)
  return total
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}
