import { describe, expect, it } from 'vitest'
import { Capability } from '../types/auth.ts'
import { missingCapabilitiesFor } from './capabilities.ts'
import {
  BUCKET_INFO_MAX_KEYS,
  BUCKET_INFO_VALUE_MAX,
  FILE_INFO_TOTAL_MAX,
  FILE_INFO_VALUE_MAX,
  FILE_NAME_MAX_BYTES,
  LIST_ENDPOINT_CAPS,
  validateBucketInfo,
  validateBucketName,
  validateFileInfo,
  validateFileName,
  validateMaxCount,
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
