/**
 * Live Object Lock coverage against a real Backblaze B2 account.
 *
 * Requires env vars:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { Capability } from '../../src/types/auth.ts'
import type { FileVersion } from '../../src/types/file.ts'
import {
  type FileRetentionValue,
  LegalHoldValue,
  type ReadableFileRetention,
  RetentionMode,
} from '../../src/types/lock.ts'
import { hasB2ErrorCode } from '../helpers/b2-cleanup.ts'
import {
  appKey,
  deleteObjectLockBucketIfPresent,
  emptyObjectLockBucket,
  isObjectLockUnavailableError,
  keyId,
  logFeatureSkip,
  makeBucketName,
  requireB2IntegrationCredentials,
  safeErrorSummary,
  setupStep,
  skipB2Integration as skip,
  sweepStaleIntegrationBuckets,
} from '../helpers/live-b2.ts'

requireB2IntegrationCredentials()

const complianceRetentionMs = 15_000
const governanceRetentionMs = 60_000
const retentionToleranceMs = 1_000
const complianceProtectedErrorCode = 'file_lock_compliance_protected'
const governanceProtectedErrorCode = 'file_lock_governance_protected'
const legalHoldProtectedErrorCode = 'file_lock_legal_hold_protected'
const objectLockFeature = 'Object Lock retention/legal hold'

const requiredCapabilities: readonly Capability[] = [
  Capability.ListBuckets,
  Capability.WriteBuckets,
  Capability.DeleteBuckets,
  Capability.ListFiles,
  Capability.ReadFiles,
  Capability.WriteFiles,
  Capability.DeleteFiles,
  Capability.ReadFileLegalHolds,
  Capability.WriteFileLegalHolds,
  Capability.ReadFileRetentions,
  Capability.WriteFileRetentions,
  Capability.BypassGovernance,
]

async function uploadText(bucket: Bucket, fileName: string, text: string): Promise<FileVersion> {
  return bucket.upload({
    fileName,
    source: new BufferSource(new TextEncoder().encode(text)),
    contentType: 'text/plain',
  })
}

function expectTimestampNear(actual: number | null, expected: number): void {
  expect(actual).not.toBeNull()
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThanOrEqual(retentionToleranceMs)
}

function expectRetentionValue(actual: FileRetentionValue, expected: FileRetentionValue): void {
  expect(actual.mode).toBe(expected.mode)
  if (expected.retainUntilTimestamp === null) {
    expect(actual.retainUntilTimestamp).toBeNull()
  } else {
    expectTimestampNear(actual.retainUntilTimestamp, expected.retainUntilTimestamp)
  }
}

function expectReadableFileRetention(
  actual: ReadableFileRetention,
  expected: FileRetentionValue,
): void {
  expect(actual.isClientAuthorizedToRead).toBe(true)
  expect(actual.value).not.toBeNull()
  if (actual.value === null) throw new Error('Expected readable file retention')
  expectRetentionValue(actual.value, expected)
}

function expectLegalHold(info: FileVersion, expected: LegalHoldValue): void {
  expect(info.legalHold).toEqual({
    isClientAuthorizedToRead: true,
    value: expected,
  })
}

async function expectB2ErrorCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  let rejected: unknown
  try {
    await promise
  } catch (err) {
    rejected = err
  }
  expect(rejected, `expected ${expectedCode}, got success`).toBeDefined()
  expect(hasB2ErrorCode(rejected, expectedCode), safeErrorSummary(rejected)).toBe(true)
}

async function assertLegalHoldSetGetAndDeleteBlock(bucket: Bucket): Promise<void> {
  const fileName = 'legal-hold.txt'
  const file = await uploadText(bucket, fileName, 'legal hold live integration')

  const holdOn = await bucket.updateFileLegalHold(fileName, file.fileId, LegalHoldValue.On)
  expect(holdOn.legalHold).toBe(LegalHoldValue.On)
  expectLegalHold(await bucket.file(fileName).getFileInfo(file.fileId), LegalHoldValue.On)

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId),
    legalHoldProtectedErrorCode,
  )

  const holdOff = await bucket.updateFileLegalHold(fileName, file.fileId, LegalHoldValue.Off)
  expect(holdOff.legalHold).toBe(LegalHoldValue.Off)
  expectLegalHold(await bucket.file(fileName).getFileInfo(file.fileId), LegalHoldValue.Off)
  await bucket.deleteFileVersion(fileName, file.fileId)
}

async function assertGovernanceRetentionSetGetAndBypass(bucket: Bucket): Promise<void> {
  const fileName = 'governance-retention.txt'
  const file = await uploadText(bucket, fileName, 'governance retention live integration')
  const retention: FileRetentionValue = {
    mode: RetentionMode.Governance,
    retainUntilTimestamp: Date.now() + governanceRetentionMs,
  }

  const retained = await bucket.updateFileRetention(fileName, file.fileId, retention)
  expectRetentionValue(retained.fileRetention, retention)
  expectReadableFileRetention(
    (await bucket.file(fileName).getFileInfo(file.fileId)).fileRetention,
    retention,
  )

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId),
    governanceProtectedErrorCode,
  )
  await bucket.deleteFileVersion(fileName, file.fileId, { bypassGovernance: true })
}

async function assertComplianceRetentionSetGetAndDeleteBlock(bucket: Bucket): Promise<void> {
  const fileName = 'compliance-retention.txt'
  const file = await uploadText(bucket, fileName, 'compliance retention live integration')
  const retention: FileRetentionValue = {
    mode: RetentionMode.Compliance,
    retainUntilTimestamp: Date.now() + complianceRetentionMs,
  }

  const retained = await bucket.updateFileRetention(fileName, file.fileId, retention)
  expectRetentionValue(retained.fileRetention, retention)
  expectReadableFileRetention(
    (await bucket.file(fileName).getFileInfo(file.fileId)).fileRetention,
    retention,
  )

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId, { bypassGovernance: true }),
    complianceProtectedErrorCode,
  )
}

describe.skipIf(skip)('B2 Object Lock integration', () => {
  let bucket: Bucket | null = null
  let setupSkipReason: string | null = null

  beforeAll(async () => {
    const liveClient = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await setupStep('authorize', () => liveClient.authorize())

    const capabilityCheck = liveClient.hasCapabilities(requiredCapabilities)
    if (!capabilityCheck.ok) {
      setupSkipReason = `missing capabilities: ${capabilityCheck.missing.join(', ')}`
      return
    }

    const existing = await setupStep('list buckets', () => liveClient.listBuckets())
    await setupStep('sweep stale integration buckets', () => sweepStaleIntegrationBuckets(existing))

    try {
      bucket = await setupStep('create Object Lock bucket', () =>
        liveClient.createBucket({
          bucketName: makeBucketName('object-lock'),
          bucketType: 'allPrivate',
          fileLockEnabled: true,
        }),
      )
    } catch (err) {
      if (isObjectLockUnavailableError(err)) {
        setupSkipReason = `file-lock bucket unavailable: ${safeErrorSummary(err)}`
        return
      }
      throw err
    }
  })

  afterEach(async () => {
    if (bucket === null) return
    await emptyObjectLockBucket(bucket)
  })

  afterAll(async () => {
    if (bucket === null) return
    await deleteObjectLockBucketIfPresent(bucket)
  })

  it('sets, gets, and removes legal hold', async (ctx) => {
    const liveBucket = requireObjectLockBucket(ctx, bucket, setupSkipReason)
    if (liveBucket === null) return

    await assertLegalHoldSetGetAndDeleteBlock(liveBucket)
  })

  it('sets, gets, and bypasses governance retention', async (ctx) => {
    const liveBucket = requireObjectLockBucket(ctx, bucket, setupSkipReason)
    if (liveBucket === null) return

    await assertGovernanceRetentionSetGetAndBypass(liveBucket)
  })

  it('sets, gets, and expires compliance retention', async (ctx) => {
    const liveBucket = requireObjectLockBucket(ctx, bucket, setupSkipReason)
    if (liveBucket === null) return

    await assertComplianceRetentionSetGetAndDeleteBlock(liveBucket)
  })
})

function requireObjectLockBucket(
  ctx: TestContext,
  bucket: Bucket | null,
  setupSkipReason: string | null,
): Bucket | null {
  if (skipIfSetupUnavailable(ctx, setupSkipReason)) return null
  if (bucket !== null) return bucket
  throw new Error('Object Lock bucket was not initialized')
}

function skipIfSetupUnavailable(ctx: TestContext, setupSkipReason: string | null): boolean {
  if (setupSkipReason === null) return false
  logFeatureSkip(objectLockFeature, setupSkipReason)
  ctx.skip(setupSkipReason)
  return true
}
