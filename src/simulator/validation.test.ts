import { describe, expect, it } from 'vitest'
import { Capability } from '../types/auth.ts'
import { missingCapabilitiesFor } from './capabilities.ts'
import {
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
 * values, malformed key shapes, non-integer counts, unknown endpoints)
 * that are hard to drive through the public API.
 */

describe('validateBucketName', () => {
  it('returns null for a valid name', () => {
    expect(validateBucketName('valid-bucket')).toBeNull()
  })
  it('rejects names with the reserved b2- prefix', () => {
    const err = validateBucketName('b2-secret')
    expect(err?.code).toBe('invalid_bucket_name')
    expect(err?.message).toMatch(/reserved prefix/)
  })
  it('rejects non-string input', () => {
    // Cast through unknown — the helper is defensive against bad callers.
    const err = validateBucketName(123 as unknown as string)
    expect(err?.code).toBe('invalid_bucket_name')
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
    expect(validateFileName('badname')?.message).toMatch(/control characters/)
  })
  it('rejects bare "." and ".."', () => {
    expect(validateFileName('.')?.message).toMatch(/exactly/)
    expect(validateFileName('..')?.message).toMatch(/exactly/)
  })
  it('rejects names over the 1024-byte UTF-8 limit', () => {
    // Each emoji is 4 UTF-8 bytes; 300 of them = 1200 bytes > 1024.
    const big = '😀'.repeat(300)
    expect(validateFileName(big)?.message).toMatch(/1024-byte/)
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
    expect(
      validateFileInfo({ k: 5 as unknown as string })?.message,
    ).toMatch(/must be a string/)
  })
  it('rejects a single value over 2048 bytes', () => {
    const long = 'a'.repeat(2049)
    expect(validateFileInfo({ k: long })?.message).toMatch(/exceeds/)
  })
  it('rejects an aggregate over the 2048-byte total budget', () => {
    // Two keys whose values together exceed the cap.
    const half = 'a'.repeat(1100)
    const err = validateFileInfo({ k1: half, k2: half })
    expect(err?.message).toMatch(/total size/)
  })
})

describe('validateBucketInfo', () => {
  it('returns null for a small valid record', () => {
    expect(validateBucketInfo({ env: 'prod' })).toBeNull()
  })
  it('rejects more than 10 keys', () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 11; i++) big[`k${i}`] = 'v'
    expect(validateBucketInfo(big)?.message).toMatch(/more than 10 keys/)
  })
  it('rejects a key with disallowed characters', () => {
    expect(validateBucketInfo({ 'bad key': 'v' })?.code).toBe('invalid_bucket_info')
  })
  it('rejects a non-string value', () => {
    expect(
      validateBucketInfo({ k: 5 as unknown as string })?.message,
    ).toMatch(/must be a string/)
  })
  it('rejects a value over 2048 bytes', () => {
    const long = 'a'.repeat(2049)
    expect(validateBucketInfo({ k: long })?.message).toMatch(/exceeds/)
  })
})

describe('validateMaxCount', () => {
  it('returns null when requested is undefined (no cap requested)', () => {
    expect(validateMaxCount(undefined, 'b2_list_file_names')).toBeNull()
  })
  it('returns null at exactly the cap', () => {
    const cap = LIST_ENDPOINT_CAPS.b2_list_file_names
    expect(validateMaxCount(cap, 'b2_list_file_names')).toBeNull()
  })
  it('rejects non-integer values', () => {
    expect(validateMaxCount(3.14, 'b2_list_file_names')?.message).toMatch(/positive integer/)
  })
  it('rejects zero', () => {
    expect(validateMaxCount(0, 'b2_list_file_names')?.message).toMatch(/positive integer/)
  })
  it('rejects negative integers', () => {
    expect(validateMaxCount(-5, 'b2_list_file_names')?.message).toMatch(/positive integer/)
  })
  it('rejects values over the cap', () => {
    const cap = LIST_ENDPOINT_CAPS.b2_list_unfinished_large_files
    expect(validateMaxCount(cap + 1, 'b2_list_unfinished_large_files')?.message).toMatch(/cap of/)
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
