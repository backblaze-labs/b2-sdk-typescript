import { describe, expect, it } from 'vitest'
import {
  BucketRetentionMode,
  BucketType,
  Capability,
  CorsOperation,
  EncryptionAlgorithm,
  EncryptionMode,
  EventType,
  FileAction,
  LegalHoldValue,
  MetadataDirective,
  RetentionMode,
} from './index.ts'

/**
 * Property tests that lock in the contract between each string-literal type
 * alias and its paired `as const` enum object:
 *
 *   - every key in the enum object resolves to a value that is still in the
 *     union (no typo can drift the const out of the type)
 *   - every value in the union appears exactly once in the enum object (no
 *     value can be added to the type and forgotten here)
 *
 * If either invariant is broken, the test fails loudly rather than only
 * `typecheck` catching it — meaning developers running `pnpm test` see the
 * regression immediately, not just CI.
 */

/**
 * Assert that every value of `values` is present in `enumObject`, and that
 * the enum object contains no extra entries. Order-independent.
 */
function expectEnumMatches<T extends string>(
  enumObject: Record<string, T>,
  values: readonly T[],
): void {
  const enumValues = Object.values(enumObject)
  expect(new Set(enumValues)).toEqual(new Set(values))
  expect(enumValues.length).toBe(values.length)
}

describe('const-object enums', () => {
  it('BucketType covers every BucketType value', () => {
    expectEnumMatches(BucketType, ['allPublic', 'allPrivate', 'snapshot', 'restricted'])
  })

  it('BucketRetentionMode covers every BucketRetentionMode value', () => {
    expectEnumMatches(BucketRetentionMode, ['compliance', 'governance', 'none'])
  })

  it('RetentionMode covers every RetentionMode value', () => {
    expectEnumMatches(RetentionMode, ['compliance', 'governance'])
  })

  it('LegalHoldValue covers every LegalHoldValue value', () => {
    expectEnumMatches(LegalHoldValue, ['on', 'off'])
  })

  it('FileAction covers every FileAction value', () => {
    expectEnumMatches(FileAction, ['start', 'upload', 'hide', 'folder', 'copy'])
  })

  it('MetadataDirective covers every MetadataDirective value', () => {
    expectEnumMatches(MetadataDirective, ['COPY', 'REPLACE'])
  })

  it('EncryptionAlgorithm covers every EncryptionAlgorithm value', () => {
    expectEnumMatches(EncryptionAlgorithm, ['AES256'])
  })

  it('EncryptionMode covers every EncryptionMode value', () => {
    expectEnumMatches(EncryptionMode, ['SSE-B2', 'SSE-C', 'none'])
  })

  it('EventType covers every EventType value', () => {
    expectEnumMatches(EventType, [
      'b2:ObjectCreated:*',
      'b2:ObjectCreated:Upload',
      'b2:ObjectCreated:MultipartUpload',
      'b2:ObjectCreated:Copy',
      'b2:ObjectCreated:Replica',
      'b2:ObjectCreated:Hide',
      'b2:ObjectDeleted:*',
      'b2:ObjectDeleted:Delete',
      'b2:ObjectDeleted:LifecycleRule',
    ])
  })

  it('CorsOperation covers every CorsOperation value', () => {
    expectEnumMatches(CorsOperation, [
      'b2_download_file_by_name',
      'b2_download_file_by_id',
      'b2_upload_file',
      'b2_upload_part',
      's3_delete',
      's3_get',
      's3_head',
      's3_post',
      's3_put',
    ])
  })

  it('Capability covers every Capability value', () => {
    expectEnumMatches(Capability, [
      'listKeys',
      'writeKeys',
      'deleteKeys',
      'listBuckets',
      'listAllBucketNames',
      'readBuckets',
      'writeBuckets',
      'deleteBuckets',
      'readBucketRetentions',
      'writeBucketRetentions',
      'readBucketEncryption',
      'writeBucketEncryption',
      'readBucketReplications',
      'writeBucketReplications',
      'readBucketNotifications',
      'writeBucketNotifications',
      'readBucketLogging',
      'writeBucketLogging',
      'listFiles',
      'readFiles',
      'shareFiles',
      'writeFiles',
      'deleteFiles',
      'readFileLegalHolds',
      'writeFileLegalHolds',
      'readFileRetentions',
      'writeFileRetentions',
      'bypassGovernance',
    ])
  })
})

describe('enum value typing (compile-time)', () => {
  // These tests pass at runtime trivially. Their real purpose is to compile
  // under verbatimModuleSyntax + exactOptionalPropertyTypes, proving:
  //   1. The enum value is assignable to the matching type alias (so callers
  //      can pass `BucketType.AllPrivate` anywhere a `BucketType` is required).
  //   2. The enum object is typed narrowly via `as const`, so unrelated
  //      string literals are rejected by TS.
  it('BucketType.AllPrivate is assignable to BucketType', () => {
    const v: BucketType = BucketType.AllPrivate
    expect(v).toBe('allPrivate')
  })

  it('LegalHoldValue.On is assignable to LegalHoldValue', () => {
    const v: LegalHoldValue = LegalHoldValue.On
    expect(v).toBe('on')
  })

  it('Capability.WriteFiles is assignable to Capability', () => {
    const v: Capability = Capability.WriteFiles
    expect(v).toBe('writeFiles')
  })

  it('EventType.ObjectCreatedAll matches the wildcard literal', () => {
    const v: EventType = EventType.ObjectCreatedAll
    expect(v).toBe('b2:ObjectCreated:*')
  })
})
