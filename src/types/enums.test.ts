import { describe, expect, it } from 'vitest'
import type { ListBucketsRequest } from './bucket.ts'
import type { CorsRule } from './index.ts'
import {
  type ApplicationKey,
  type BucketInfo,
  BucketKeyOption,
  type BucketResponseType,
  BucketRetentionMode,
  BucketType,
  Capability,
  CORS_ALLOWED_OPERATIONS,
  CorsOperation,
  type CreateBucketRequest,
  computerId,
  EncryptionAlgorithm,
  EncryptionMode,
  EventType,
  FileAction,
  groupId,
  type KnownBucketKeyOption,
  KnownBucketResponseType,
  keyId,
  LegalHoldValue,
  MetadataDirective,
  PartnerCapability,
  Region,
  RetentionMode,
} from './index.ts'

/**
 * Property tests that lock in the contract between string-literal type
 * aliases and their paired `as const` enum objects:
 *
 *   - every key in the enum object resolves to an expected string literal
 *   - every expected enum value appears exactly once in the enum object
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
  it('BucketType covers every request bucketType value', () => {
    expectEnumMatches(BucketType, ['allPublic', 'allPrivate', 'snapshot', 'restricted'])
  })

  it('KnownBucketResponseType covers every documented response bucketType value', () => {
    expectEnumMatches(KnownBucketResponseType, [
      'allPublic',
      'allPrivate',
      'snapshot',
      'restricted',
      'shared',
    ])
  })

  it('BucketRetentionMode covers every BucketRetentionMode value', () => {
    expectEnumMatches(BucketRetentionMode, ['compliance', 'governance', 'none'])
  })

  it('BucketKeyOption covers every bucket/key option value', () => {
    expectEnumMatches(BucketKeyOption, ['s3'])
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
      's3_get',
      's3_post',
      's3_put',
      's3_head',
      's3_delete',
    ])
  })

  it('CORS_ALLOWED_OPERATIONS excludes deprecated S3Post', () => {
    expect(CORS_ALLOWED_OPERATIONS).not.toContain(CorsOperation.S3Post)
  })

  it('CorsRule excludes deprecated S3Post from allowed operations', () => {
    const rule: CorsRule = {
      allowedOperations: [CorsOperation.B2DownloadFileByName],
      allowedOrigins: ['https://example.com'],
      corsRuleName: 'rule-1',
      maxAgeSeconds: 3600,
    }

    const invalidRule: CorsRule = {
      ...rule,
      // @ts-expect-error s3_post remains exported but is not accepted in CORS rules.
      allowedOperations: [CorsOperation.S3Post],
    }

    expect(rule.allowedOperations).toEqual([CorsOperation.B2DownloadFileByName])
    expect(invalidRule.allowedOperations).toEqual([CorsOperation.S3Post])
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
      'readBucketLifecycleRules',
      'writeBucketLifecycleRules',
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

  it('PartnerCapability covers every PartnerCapability value', () => {
    expectEnumMatches(PartnerCapability, ['all'])
  })

  it('Region covers every Region value', () => {
    expectEnumMatches(Region, ['us-east', 'us-west', 'ca-east', 'eu-central'])
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

  it('KnownBucketResponseType.Shared is assignable to known and open response bucket types', () => {
    const known: KnownBucketResponseType = KnownBucketResponseType.Shared
    const v: BucketResponseType = known
    expect(v).toBe('shared')
  })

  it('BucketResponseType accepts future B2 bucket type strings', () => {
    const v: BucketResponseType = 'futureBucketType'
    expect(v).toBe('futureBucketType')
  })

  it('BucketKeyOption.S3 is assignable to bucket and key option arrays', () => {
    const v: BucketKeyOption = BucketKeyOption.S3
    const known: KnownBucketKeyOption = BucketKeyOption.S3
    const bucketOptions: BucketInfo['options'] = [BucketKeyOption.S3]
    const keyOptions: ApplicationKey['options'] = [BucketKeyOption.S3]

    expect(v).toBe('s3')
    expect(known).toBe('s3')
    expect(bucketOptions).toEqual(['s3'])
    expect(keyOptions).toEqual(['s3'])
  })

  it('bucket and key option arrays accept future B2 option strings', () => {
    const bucketOptions: BucketInfo['options'] = ['future-option']
    const keyOptions: ApplicationKey['options'] = ['future-option']

    expect(bucketOptions).toEqual(['future-option'])
    expect(keyOptions).toEqual(['future-option'])
  })

  it('response-only and list-only bucket types use separate contracts', () => {
    function acceptsCreateBucketType(_value: CreateBucketRequest['bucketType']): true {
      return true
    }
    function acceptsListBucketTypes(_value: NonNullable<ListBucketsRequest['bucketTypes']>): true {
      return true
    }

    const mutableRequestFilters: BucketType[] = [BucketType.AllPrivate]
    const readonlyRequestFilters: readonly BucketType[] = [BucketType.AllPrivate]
    expect(acceptsCreateBucketType(BucketType.AllPrivate)).toBe(true)
    expect(Object.values(BucketType)).not.toContain(KnownBucketResponseType.Shared)
    expect(acceptsListBucketTypes([BucketType.AllPrivate])).toBe(true)
    expect(acceptsListBucketTypes(mutableRequestFilters)).toBe(true)
    expect(acceptsListBucketTypes(readonlyRequestFilters)).toBe(true)
    expect(acceptsListBucketTypes([KnownBucketResponseType.Shared])).toBe(true)
    expect(acceptsListBucketTypes(['futureBucketType'])).toBe(true)
    expect(acceptsListBucketTypes(['all'])).toBe(true)
    // @ts-expect-error shared is a response-only bucket type.
    acceptsCreateBucketType(KnownBucketResponseType.Shared)
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

  it('PartnerCapability.All is assignable to PartnerCapability', () => {
    const v: PartnerCapability = PartnerCapability.All
    expect(v).toBe('all')
  })

  it('Region.UsWest is assignable to Region', () => {
    const v: Region = Region.UsWest
    expect(v).toBe('us-west')
  })
})

describe('branded ID factories', () => {
  it('re-exports branded ID factories from the type barrel', () => {
    expect(keyId('app-key-id')).toBe('app-key-id')
    expect(groupId('254')).toBe('254')
    expect(computerId('deb0b1bcd412a7759709081c')).toBe('deb0b1bcd412a7759709081c')
  })
})
