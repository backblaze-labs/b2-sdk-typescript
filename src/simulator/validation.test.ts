import { describe, expect, it } from 'vitest'
import { Capability } from '../types/auth.ts'
import { BucketRetentionMode, CorsOperation } from '../types/bucket.ts'
import { EventType } from '../types/notifications.ts'
import { missingCapabilitiesFor } from './capabilities.ts'
import {
  BUCKET_INFO_MAX_KEYS,
  BUCKET_INFO_VALUE_MAX,
  DOWNLOAD_AUTH_DURATION_MAX_SECONDS,
  DOWNLOAD_AUTH_DURATION_MIN_SECONDS,
  FILE_INFO_TOTAL_MAX,
  FILE_INFO_VALUE_MAX,
  FILE_NAME_MAX_BYTES,
  KEY_NAME_MAX,
  LIST_ENDPOINT_CAPS,
  normalizeCreateKeyCapabilities,
  validateBucketInfo,
  validateBucketName,
  validateBucketTypes,
  validateCorsRules,
  validateCreateKeyCapabilities,
  validateCreateKeyName,
  validateDefaultRetention,
  validateDownloadAuthorizationDuration,
  validateDownloadAuthorizationPrefix,
  validateFileInfo,
  validateFileName,
  validateLifecycleRules,
  validateMaxCount,
  validateNotificationRules,
  validateReplicationConfiguration,
} from './validation.ts'

/**
 * Direct unit tests for the validation helpers. The simulator-level
 * tests in `fidelity.test.ts` exercise the happy + common-reject paths
 * end-to-end; these target the remaining edge branches (oversized
 * values, malformed key shapes, non-integer counts, unknown endpoints).
 *
 * Assertions key off the structured `.code` field rather than the
 * human-readable `.message`, so wording changes don't ripple through
 * these tests.
 */

describe('validateCreateKeyCapabilities', () => {
  it('returns null for valid capabilities', () => {
    expect(validateCreateKeyCapabilities([Capability.ListBuckets])).toBeNull()
  })

  it('rejects empty, non-array, and unknown capabilities', () => {
    expect(validateCreateKeyCapabilities([])?.code).toBe('bad_request')
    expect(validateCreateKeyCapabilities('listBuckets')?.code).toBe('bad_request')
    expect(validateCreateKeyCapabilities(['notReal'])?.code).toBe('bad_request')
    expect(validateCreateKeyCapabilities([123])?.code).toBe('bad_request')
  })

  it('normalizes capabilities to a frozen defensive copy', () => {
    const original: Capability[] = [Capability.ListBuckets]
    const normalized = normalizeCreateKeyCapabilities(original)

    original.push(Capability.DeleteBuckets)
    expect(normalized).toEqual([Capability.ListBuckets])
    expect(Object.isFrozen(normalized)).toBe(true)
  })
})

describe('validateCreateKeyName', () => {
  it('returns null for valid keyName', () => {
    expect(validateCreateKeyName('valid-key')).toBeNull()
  })

  it('rejects non-string keyName and names outside the B2 length range', () => {
    expect(validateCreateKeyName(42)?.code).toBe('bad_request')
    expect(validateCreateKeyName(null)?.code).toBe('bad_request')
    expect(validateCreateKeyName('')?.code).toBe('bad_request')
    expect(validateCreateKeyName('k'.repeat(KEY_NAME_MAX + 1))?.code).toBe('bad_request')
  })
})

describe('validateBucketName', () => {
  it('returns null for a valid name', () => {
    expect(validateBucketName('valid-bucket')).toBeNull()
    expect(validateBucketName('valid.bucket')).toBeNull()
  })
  it('rejects names with the reserved b2- prefix', () => {
    expect(validateBucketName('b2-secret')?.code).toBe('invalid_bucket_name')
  })
  it('rejects IPv4-address-form names', () => {
    expect(validateBucketName('192.168.0.1')?.code).toBe('invalid_bucket_name')
  })
  it('rejects non-string input', () => {
    expect(validateBucketName(123 as unknown as string)?.code).toBe('invalid_bucket_name')
  })
})

describe('validateFileName', () => {
  it('returns null for a valid name', () => {
    expect(validateFileName('path/to/file.txt')).toBeNull()
  })
  it('rejects empty strings', () => {
    expect(validateFileName('')?.code).toBe('invalid_file_name')
  })
  it('rejects names with control characters (DEL)', () => {
    expect(validateFileName('bad\x7Fname')?.code).toBe('invalid_file_name')
  })
  it('rejects bare "." and ".."', () => {
    expect(validateFileName('.')?.code).toBe('invalid_file_name')
    expect(validateFileName('..')?.code).toBe('invalid_file_name')
  })
  it(`rejects names over the ${FILE_NAME_MAX_BYTES}-byte UTF-8 limit`, () => {
    // Each emoji is 4 UTF-8 bytes; (limit / 4) + 1 emojis exceeds the cap.
    const overshoot = '\u{1F600}'.repeat(Math.ceil(FILE_NAME_MAX_BYTES / 4) + 1)
    expect(validateFileName(overshoot)?.code).toBe('invalid_file_name')
  })
})

describe('validateFileInfo', () => {
  it('returns null for an empty record', () => {
    expect(validateFileInfo({})).toBeNull()
  })
  it('rejects a key with disallowed characters', () => {
    expect(validateFileInfo({ 'bad key': 'v' })?.code).toBe('invalid_file_info')
  })
  it('rejects a non-string value', () => {
    expect(validateFileInfo({ k: 5 as unknown as string })?.code).toBe('invalid_file_info')
  })
  it(`rejects a single value over ${FILE_INFO_VALUE_MAX} bytes`, () => {
    const long = 'a'.repeat(FILE_INFO_VALUE_MAX + 1)
    expect(validateFileInfo({ k: long })?.code).toBe('invalid_file_info')
  })
  it(`rejects an aggregate over the ${FILE_INFO_TOTAL_MAX}-byte total budget`, () => {
    // Two keys whose values together exceed the cap but each fits.
    const half = 'a'.repeat(Math.floor(FILE_INFO_TOTAL_MAX / 2) + 50)
    expect(validateFileInfo({ k1: half, k2: half })?.code).toBe('invalid_file_info')
  })
})

describe('validateBucketInfo', () => {
  it('returns null for a small valid record', () => {
    expect(validateBucketInfo({ env: 'prod' })).toBeNull()
  })
  it(`rejects more than ${BUCKET_INFO_MAX_KEYS} keys`, () => {
    const big: Record<string, string> = {}
    for (let i = 0; i <= BUCKET_INFO_MAX_KEYS; i++) big[`k${i}`] = 'v'
    expect(validateBucketInfo(big)?.code).toBe('invalid_bucket_info')
  })
  it('rejects a key with disallowed characters', () => {
    expect(validateBucketInfo({ 'bad key': 'v' })?.code).toBe('invalid_bucket_info')
  })
  it('rejects a non-string value', () => {
    expect(validateBucketInfo({ k: 5 as unknown as string })?.code).toBe('invalid_bucket_info')
  })
  it(`rejects a value over ${BUCKET_INFO_VALUE_MAX} bytes`, () => {
    const long = 'a'.repeat(BUCKET_INFO_VALUE_MAX + 1)
    expect(validateBucketInfo({ k: long })?.code).toBe('invalid_bucket_info')
  })
})

describe('validateMaxCount', () => {
  it('returns null when requested is undefined (no cap requested)', () => {
    expect(validateMaxCount(undefined, 'b2_list_file_names')).toBeNull()
  })
  it('returns null at exactly the cap', () => {
    expect(validateMaxCount(LIST_ENDPOINT_CAPS.b2_list_file_names, 'b2_list_file_names')).toBeNull()
  })
  it('rejects non-integer values', () => {
    expect(validateMaxCount(3.14, 'b2_list_file_names')?.code).toBe('bad_request')
  })
  it('rejects zero', () => {
    expect(validateMaxCount(0, 'b2_list_file_names')?.code).toBe('bad_request')
  })
  it('rejects negative integers', () => {
    expect(validateMaxCount(-5, 'b2_list_file_names')?.code).toBe('bad_request')
  })
  it('rejects values over the cap', () => {
    const cap = LIST_ENDPOINT_CAPS.b2_list_unfinished_large_files
    expect(validateMaxCount(cap + 1, 'b2_list_unfinished_large_files')?.code).toBe('bad_request')
  })
})

describe('validateDownloadAuthorizationDuration', () => {
  it('returns null at the documented inclusive bounds', () => {
    expect(validateDownloadAuthorizationDuration(DOWNLOAD_AUTH_DURATION_MIN_SECONDS)).toBeNull()
    expect(validateDownloadAuthorizationDuration(DOWNLOAD_AUTH_DURATION_MAX_SECONDS)).toBeNull()
  })

  it('rejects values outside the documented range', () => {
    expect(
      validateDownloadAuthorizationDuration(DOWNLOAD_AUTH_DURATION_MIN_SECONDS - 1)?.code,
    ).toBe('bad_request')
    expect(
      validateDownloadAuthorizationDuration(DOWNLOAD_AUTH_DURATION_MAX_SECONDS + 1)?.code,
    ).toBe('bad_request')
  })

  it('rejects non-integer and non-number values', () => {
    expect(validateDownloadAuthorizationDuration(1.5)?.code).toBe('bad_request')
    expect(validateDownloadAuthorizationDuration('60')?.code).toBe('bad_request')
  })
})

describe('validateDownloadAuthorizationPrefix', () => {
  it('accepts empty and non-empty string prefixes', () => {
    expect(validateDownloadAuthorizationPrefix('')).toBeNull()
    expect(validateDownloadAuthorizationPrefix('allowed/')).toBeNull()
  })

  it('rejects missing and non-string prefixes', () => {
    expect(validateDownloadAuthorizationPrefix(undefined)?.code).toBe('bad_request')
    expect(validateDownloadAuthorizationPrefix(42)?.code).toBe('bad_request')
  })
})

describe('validateBucketTypes', () => {
  it('accepts undefined and known bucket type arrays', () => {
    expect(validateBucketTypes(undefined)).toBeNull()
    expect(validateBucketTypes(['allPrivate', 'allPublic'])).toBeNull()
  })

  it('rejects non-array and unknown bucket type values', () => {
    expect(validateBucketTypes(null)?.code).toBe('bad_request')
    expect(validateBucketTypes({})?.code).toBe('bad_request')
    expect(validateBucketTypes('allPrivate')?.code).toBe('bad_request')
    expect(validateBucketTypes(['shared'])?.code).toBe('bad_request')
    expect(validateBucketTypes(['allPrivate', 'not-real'])?.code).toBe('bad_request')
  })
})

describe('validateCorsRules', () => {
  const validRule = {
    allowedHeaders: null,
    allowedOperations: [CorsOperation.B2DownloadFileByName],
    allowedOrigins: ['https://example.com'],
    corsRuleName: 'downloads',
    exposeHeaders: ['x-bz-content-sha1'],
    maxAgeSeconds: 3600,
  }

  it('returns null for an empty list and valid CORS rules', () => {
    expect(validateCorsRules([])).toBeNull()
    expect(validateCorsRules([validRule])).toBeNull()
  })

  it('rejects malformed CORS rule fields', () => {
    expect(validateCorsRules('not-rules')?.code).toBe('bad_request')
    expect(validateCorsRules([null])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, extra: true }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, corsRuleName: '' }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, allowedOrigins: 'https://example.com' }])?.code).toBe(
      'bad_request',
    )
    expect(validateCorsRules([{ ...validRule, allowedOrigins: [] }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, allowedOrigins: [42] }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, allowedOperations: [] }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, allowedOperations: ['not_real'] }])?.code).toBe(
      'bad_request',
    )
    expect(validateCorsRules([{ ...validRule, allowedHeaders: 'x-bz-info-test' }])?.code).toBe(
      'bad_request',
    )
    expect(validateCorsRules([{ ...validRule, allowedHeaders: [42] }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, exposeHeaders: [42] }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, maxAgeSeconds: -1 }])?.code).toBe('bad_request')
    expect(validateCorsRules([{ ...validRule, maxAgeSeconds: 86_400 }])).toBeNull()
    expect(validateCorsRules([{ ...validRule, maxAgeSeconds: 86_401 }])?.code).toBe('bad_request')
    expect(validateCorsRules([validRule, { ...validRule }])?.message).toMatch(/unique/)
  })
})

describe('validateLifecycleRules', () => {
  const validRule = {
    daysFromHidingToDeleting: 30,
    daysFromUploadingToHiding: null,
    fileNamePrefix: 'tmp/',
  }

  it('returns null for an empty list and valid lifecycle rules', () => {
    expect(validateLifecycleRules([])).toBeNull()
    expect(validateLifecycleRules([validRule])).toBeNull()
    expect(
      validateLifecycleRules([{ daysFromHidingToDeleting: 30, fileNamePrefix: 'tmp/' }]),
    ).toBeNull()
    expect(
      validateLifecycleRules([
        {
          daysFromStartingToCancelingUnfinishedLargeFiles: 3,
          fileNamePrefix: 'uploads/',
        },
      ]),
    ).toBeNull()
  })

  it('rejects malformed lifecycle rule fields', () => {
    expect(validateLifecycleRules('not-rules')?.code).toBe('bad_request')
    expect(validateLifecycleRules([null])?.code).toBe('bad_request')
    expect(validateLifecycleRules([{ ...validRule, extra: true }])?.code).toBe('bad_request')
    expect(validateLifecycleRules([{ ...validRule, daysFromHidingToDeleting: 1.5 }])?.code).toBe(
      'bad_request',
    )
    expect(validateLifecycleRules([{ ...validRule, daysFromUploadingToHiding: 1.5 }])?.code).toBe(
      'bad_request',
    )
    expect(
      validateLifecycleRules([
        {
          ...validRule,
          daysFromStartingToCancelingUnfinishedLargeFiles: 0,
        },
      ])?.code,
    ).toBe('bad_request')
    expect(
      validateLifecycleRules([
        {
          ...validRule,
          daysFromStartingToCancelingUnfinishedLargeFiles: null,
          daysFromHidingToDeleting: null,
          daysFromUploadingToHiding: null,
        },
      ])?.code,
    ).toBe('bad_request')
    expect(validateLifecycleRules([{ ...validRule, fileNamePrefix: 42 }])?.code).toBe('bad_request')
  })
})

describe('validateDefaultRetention', () => {
  it('returns null for valid none and retention-mode policies', () => {
    expect(validateDefaultRetention({ mode: BucketRetentionMode.None, period: null })).toBeNull()
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: 7, unit: 'days' },
      }),
    ).toBeNull()
  })

  it('rejects malformed default retention policies', () => {
    expect(validateDefaultRetention(null)?.code).toBe('bad_request')
    expect(
      validateDefaultRetention({
        extra: true,
        mode: BucketRetentionMode.None,
        period: null,
      })?.code,
    ).toBe('bad_request')
    expect(validateDefaultRetention({ mode: 'temporary', period: null })?.code).toBe('bad_request')
    expect(
      validateDefaultRetention({ mode: BucketRetentionMode.None, period: { duration: 1 } })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({ mode: BucketRetentionMode.Compliance, period: null })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: 0, unit: 'days' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: 7, extra: true, unit: 'days' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: 7, unit: 'months' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: Number.MAX_SAFE_INTEGER + 1, unit: 'days' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Governance,
        period: { duration: 3001, unit: 'days' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateDefaultRetention({
        mode: BucketRetentionMode.Compliance,
        period: { duration: 1e308, unit: 'years' },
      })?.code,
    ).toBe('bad_request')
  })
})

describe('validateReplicationConfiguration', () => {
  const validConfig = {
    asReplicationDestination: null,
    asReplicationSource: {
      replicationRules: [
        {
          destinationBucketId: 'dest-bucket-id',
          fileNamePrefix: '',
          includeExistingFiles: false,
          isEnabled: true,
          priority: 1,
          replicationRuleName: 'replicate-all',
        },
      ],
      sourceApplicationKeyId: 'source-key-id',
    },
  }

  it('returns null for empty and valid replication configurations', () => {
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: null,
        asReplicationSource: null,
      }),
    ).toBeNull()
    expect(validateReplicationConfiguration(validConfig)).toBeNull()
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: {
          sourceToDestinationKeyMapping: { 'source-key-id': 'destination-key-id' },
        },
        asReplicationSource: null,
      }),
    ).toBeNull()
  })

  it('rejects malformed replication configuration fields', () => {
    expect(validateReplicationConfiguration(null)?.code).toBe('bad_request')
    expect(validateReplicationConfiguration({})?.code).toBe('bad_request')
    expect(validateReplicationConfiguration({ extra: true })?.code).toBe('bad_request')
    expect(validateReplicationConfiguration({ asReplicationSource: 42 })?.code).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationSource: {
          extra: true,
          replicationRules: [],
          sourceApplicationKeyId: 'source-key-id',
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationSource: { replicationRules: [], sourceApplicationKeyId: '' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationSource: { sourceApplicationKeyId: 'source-key-id' },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationSource: {
          replicationRules: [null],
          sourceApplicationKeyId: 'source-key-id',
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            { ...validConfig.asReplicationSource.replicationRules[0], extra: true },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              destinationBucketId: '',
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              fileNamePrefix: 42,
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              includeExistingFiles: 'false',
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              isEnabled: 'true',
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              priority: 0,
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            {
              ...validConfig.asReplicationSource.replicationRules[0],
              replicationRuleName: '',
            },
          ],
        },
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        ...validConfig,
        asReplicationSource: {
          ...validConfig.asReplicationSource,
          replicationRules: [
            validConfig.asReplicationSource.replicationRules[0],
            { ...validConfig.asReplicationSource.replicationRules[0] },
          ],
        },
      })?.message,
    ).toMatch(/unique/)
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: 42,
        asReplicationSource: null,
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: { extra: true, sourceToDestinationKeyMapping: {} },
        asReplicationSource: null,
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: { sourceToDestinationKeyMapping: null },
        asReplicationSource: null,
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: { sourceToDestinationKeyMapping: { '': 'destination-key-id' } },
        asReplicationSource: null,
      })?.code,
    ).toBe('bad_request')
    expect(
      validateReplicationConfiguration({
        asReplicationDestination: { sourceToDestinationKeyMapping: { source: 42 } },
        asReplicationSource: null,
      })?.code,
    ).toBe('bad_request')
  })
})

describe('validateNotificationRules', () => {
  const validRule = {
    eventTypes: [EventType.ObjectCreatedAll],
    isEnabled: true,
    name: 'upload-webhook',
    objectNamePrefix: '',
    targetConfiguration: {
      targetType: 'webhook',
      url: 'https://example.com/webhook',
    },
  }

  it('returns null for an empty rule list and valid rules', () => {
    expect(validateNotificationRules([])).toBeNull()
    expect(validateNotificationRules([validRule])).toBeNull()
  })

  it('rejects empty and duplicate names', () => {
    expect(validateNotificationRules([{ ...validRule, name: '' }])?.message).toMatch(
      /non-empty string/,
    )
    expect(validateNotificationRules([validRule, { ...validRule }])?.message).toMatch(/unique/)
  })

  it('rejects unknown event types', () => {
    expect(
      validateNotificationRules([{ ...validRule, eventTypes: 'b2:ObjectCreated:*' }])?.code,
    ).toBe('bad_request')
    expect(validateNotificationRules([{ ...validRule, eventTypes: [] }])?.code).toBe('bad_request')
    expect(
      validateNotificationRules([{ ...validRule, eventTypes: ['b2:ObjectCreated:Typo'] }])?.message,
    ).toMatch(/unknown event type/)
  })

  it('rejects non-boolean isEnabled values', () => {
    expect(validateNotificationRules([{ ...validRule, isEnabled: 'false' }])?.message).toMatch(
      /isEnabled/,
    )
    expect(validateNotificationRules([{ ...validRule, isEnabled: undefined }])?.message).toMatch(
      /isEnabled/,
    )
  })

  it('accepts positive integer maxEventsPerBatch values', () => {
    expect(validateNotificationRules([{ ...validRule, maxEventsPerBatch: 5 }])).toBeNull()
  })

  it('rejects invalid maxEventsPerBatch values', () => {
    expect(validateNotificationRules([{ ...validRule, maxEventsPerBatch: '5' }])?.message).toMatch(
      /maxEventsPerBatch/,
    )
    expect(validateNotificationRules([{ ...validRule, maxEventsPerBatch: 0 }])?.message).toMatch(
      /maxEventsPerBatch/,
    )
  })

  it('rejects non-webhook targets and non-https URLs', () => {
    expect(validateNotificationRules('not-rules')?.code).toBe('bad_request')
    expect(validateNotificationRules([null])?.code).toBe('bad_request')
    expect(validateNotificationRules([{ ...validRule, targetConfiguration: null }])?.code).toBe(
      'bad_request',
    )
    expect(
      validateNotificationRules([
        {
          ...validRule,
          targetConfiguration: { targetType: 'url', url: 'https://example.com/webhook' },
        },
      ])?.message,
    ).toMatch(/targetType/)
    expect(
      validateNotificationRules([
        {
          ...validRule,
          targetConfiguration: { targetType: 'webhook', url: 42 },
        },
      ])?.message,
    ).toMatch(/https URL/)
    expect(
      validateNotificationRules([
        {
          ...validRule,
          targetConfiguration: { targetType: 'webhook', url: 'not a url' },
        },
      ])?.message,
    ).toMatch(/https URL/)
    expect(
      validateNotificationRules([
        {
          ...validRule,
          targetConfiguration: { targetType: 'webhook', url: 'http://example.com/webhook' },
        },
      ])?.message,
    ).toMatch(/https URL/)
  })

  it('rejects unknown rule and target fields', () => {
    expect(validateNotificationRules([{ ...validRule, extra: true }])?.message).toMatch(
      /not a supported field/,
    )
    expect(
      validateNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            targetType: 'webhook',
            url: 'https://example.com/webhook',
            extra: true,
          },
        },
      ])?.message,
    ).toMatch(/not a supported field/)
  })
})

describe('missingCapabilitiesFor', () => {
  it('returns the missing caps for a known endpoint', () => {
    const missing = missingCapabilitiesFor('b2_upload_file', [Capability.ListBuckets])
    expect(missing).toContain(Capability.WriteFiles)
  })
  it('returns empty when all required caps are granted', () => {
    const missing = missingCapabilitiesFor('b2_upload_file', [Capability.WriteFiles])
    expect(missing).toEqual([])
  })
  it('returns empty for an unknown endpoint (no cap requirement)', () => {
    const missing = missingCapabilitiesFor('b2_not_a_real_endpoint', [])
    expect(missing).toEqual([])
  })
  it('returns empty for endpoints with no requirement (e.g. b2_authorize_account)', () => {
    expect(missingCapabilitiesFor('b2_authorize_account', [])).toEqual([])
  })
})
