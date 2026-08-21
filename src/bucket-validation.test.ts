import { describe, expect, it } from 'vitest'

import {
  assertValidBucketConfiguration,
  assertValidBucketInfo,
  assertValidCorsRules,
} from './bucket-validation.ts'
import { B2BucketConfigurationError } from './errors/index.ts'
import {
  BUCKET_INFO_KEY_MAX_BYTES,
  BUCKET_INFO_VALUES_MAX_BYTES,
  CORS_MAX_AGE_SECONDS_MAX,
  CORS_RULE_MAX_BYTES,
  CORS_RULE_NAME_MAX_LENGTH,
  CORS_RULE_NAME_MIN_LENGTH,
  CORS_RULES_MAX_COUNT,
  CorsOperation,
  type CorsRule,
} from './types/bucket.ts'

function validCorsRule(overrides: Partial<CorsRule> = {}): CorsRule {
  return {
    allowedHeaders: null,
    allowedOperations: [CorsOperation.B2DownloadFileByName],
    allowedOrigins: ['https://example.com'],
    corsRuleName: 'rule-1',
    exposeHeaders: null,
    maxAgeSeconds: 3600,
    ...overrides,
  }
}

function expectBucketConfigurationError(
  fn: () => void,
  field: 'bucketInfo' | 'corsRules',
  code: 'bad_request' | 'invalid_bucket_info',
  message: string | RegExp,
): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }

  expect(caught).toBeInstanceOf(B2BucketConfigurationError)
  expect(caught).toMatchObject({
    code,
    field,
    name: 'B2BucketConfigurationError',
    retryable: false,
    status: 400,
  })
  const err = caught as Error
  if (typeof message === 'string') {
    expect(err.message).toContain(message)
  } else {
    expect(err.message).toMatch(message)
  }
}

describe('bucket configuration validation', () => {
  it('accepts valid bucketInfo without a pair-count cap', () => {
    const bucketInfo: Record<string, string> = {}
    for (let i = 0; i < 60; i++) bucketInfo[`key_${i}`] = 'v'

    expect(() => assertValidBucketInfo(bucketInfo)).not.toThrow()
  })

  it('rejects bucketInfo keys outside the documented UTF-8 byte range', () => {
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ '': 'value' }),
      'bucketInfo',
      'invalid_bucket_info',
      'must be 1-50 UTF-8 bytes',
    )

    const oversizedKey = 'é'.repeat(Math.floor(BUCKET_INFO_KEY_MAX_BYTES / 2) + 1)
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ [oversizedKey]: 'value' }),
      'bucketInfo',
      'invalid_bucket_info',
      'must be 1-50 UTF-8 bytes',
    )
  })

  it('rejects bucketInfo keys using the reserved b2- prefix', () => {
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ 'b2-system': 'value' }),
      'bucketInfo',
      'invalid_bucket_info',
      'must not start with reserved prefix "b2-"',
    )
  })

  it('rejects bucketInfo keys with unsupported characters', () => {
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ 'bad/key': 'value' }),
      'bucketInfo',
      'invalid_bucket_info',
      'must match ^[A-Za-z0-9_-]+$',
    )
  })

  it('rejects non-string bucketInfo values', () => {
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ key: 42 as unknown as string }),
      'bucketInfo',
      'invalid_bucket_info',
      'must be a string',
    )
  })

  it('rejects bucketInfo values over the documented aggregate UTF-8 byte budget', () => {
    expectBucketConfigurationError(
      () => assertValidBucketInfo({ key: 'a'.repeat(BUCKET_INFO_VALUES_MAX_BYTES + 1) }),
      'bucketInfo',
      'invalid_bucket_info',
      'exceeds the 10000-byte limit',
    )
  })

  it('accepts valid CORS rules', () => {
    expect(() =>
      assertValidCorsRules([
        validCorsRule({
          allowedHeaders: ['authorization'],
          allowedOperations: [
            CorsOperation.B2DownloadFileByName,
            CorsOperation.B2DownloadFileById,
            CorsOperation.B2UploadFile,
            CorsOperation.B2UploadPart,
            CorsOperation.S3Get,
            CorsOperation.S3Put,
            CorsOperation.S3Head,
            CorsOperation.S3Delete,
          ],
          exposeHeaders: ['x-bz-content-sha1'],
        }),
      ]),
    ).not.toThrow()
  })

  it('accepts CORS rules with omitted optional header fields', () => {
    expect(() =>
      assertValidCorsRules([
        {
          allowedOperations: [CorsOperation.B2DownloadFileByName],
          allowedOrigins: ['https://example.com'],
          corsRuleName: 'rule-1',
          maxAgeSeconds: 3600,
        },
      ]),
    ).not.toThrow()
  })

  it('rejects more than the documented CORS rule count', () => {
    const rules = Array.from({ length: CORS_RULES_MAX_COUNT + 1 }, (_, index) =>
      validCorsRule({ corsRuleName: `rule-${index}` }),
    )

    expectBucketConfigurationError(
      () => assertValidCorsRules(rules),
      'corsRules',
      'bad_request',
      `cannot have more than ${CORS_RULES_MAX_COUNT} rules`,
    )
  })

  it('rejects CORS rule names outside the documented length range', () => {
    expectBucketConfigurationError(
      () =>
        assertValidCorsRules([
          validCorsRule({ corsRuleName: 'r'.repeat(CORS_RULE_NAME_MIN_LENGTH - 1) }),
        ]),
      'corsRules',
      'bad_request',
      'must be 6-63 characters',
    )

    expectBucketConfigurationError(
      () =>
        assertValidCorsRules([
          validCorsRule({ corsRuleName: 'r'.repeat(CORS_RULE_NAME_MAX_LENGTH + 1) }),
        ]),
      'corsRules',
      'bad_request',
      'must be 6-63 characters',
    )
  })

  it('rejects CORS rule names with unsupported characters', () => {
    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule({ corsRuleName: 'bad_name' })]),
      'corsRules',
      'bad_request',
      'must match ^[A-Za-z0-9-]+$',
    )
  })

  it('rejects CORS rule names using the reserved b2- prefix', () => {
    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule({ corsRuleName: 'b2-bad' })]),
      'corsRules',
      'bad_request',
      'must not start with reserved prefix "b2-"',
    )
  })

  it('rejects duplicate CORS rule names within a bucket', () => {
    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule(), validCorsRule()]),
      'corsRules',
      'bad_request',
      'must be unique within the bucket',
    )
  })

  it('rejects CORS rules at or over the documented rule byte ceiling', () => {
    expectBucketConfigurationError(
      () =>
        assertValidCorsRules([
          validCorsRule({ allowedOrigins: ['a'.repeat(CORS_RULE_MAX_BYTES)] }),
        ]),
      'corsRules',
      'bad_request',
      'must be less than 1000 bytes',
    )
  })

  it('rejects empty CORS allowedOrigins and allowedOperations lists', () => {
    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule({ allowedOrigins: [] })]),
      'corsRules',
      'bad_request',
      'allowedOrigins must contain at least one item',
    )

    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule({ allowedOperations: [] })]),
      'corsRules',
      'bad_request',
      'allowedOperations must contain at least one item',
    )
  })

  it('rejects unsupported CORS operations', () => {
    expectBucketConfigurationError(
      () =>
        assertValidCorsRules([
          validCorsRule({
            allowedOperations: ['s3_post'] as unknown as CorsRule['allowedOperations'],
          }),
        ]),
      'corsRules',
      'bad_request',
      'unsupported operation "s3_post"',
    )
  })

  it(`rejects maxAgeSeconds above ${CORS_MAX_AGE_SECONDS_MAX}`, () => {
    expectBucketConfigurationError(
      () => assertValidCorsRules([validCorsRule({ maxAgeSeconds: CORS_MAX_AGE_SECONDS_MAX + 1 })]),
      'corsRules',
      'bad_request',
      `maxAgeSeconds must be at most ${CORS_MAX_AGE_SECONDS_MAX}`,
    )
  })

  it('validates bucketInfo and CORS rules through the combined helper', () => {
    expect(() =>
      assertValidBucketConfiguration({
        bucketInfo: { env: 'prod' },
        corsRules: [validCorsRule()],
      }),
    ).not.toThrow()
  })
})
