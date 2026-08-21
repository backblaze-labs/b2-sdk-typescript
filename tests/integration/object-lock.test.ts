/**
 * Live Object Lock coverage against a real Backblaze B2 account.
 *
 * Requires env vars:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 */

import { describe, expect, it, type TestContext } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { Capability, type Capability as CapabilityValue } from '../../src/types/auth.ts'
import { BucketType } from '../../src/types/bucket.ts'
import type { FileVersion } from '../../src/types/file.ts'
import type { FileId } from '../../src/types/ids.ts'
import {
  type FileRetentionValue,
  LegalHoldValue,
  type ReadableFileRetention,
  RetentionMode,
} from '../../src/types/lock.ts'
import { deleteFileVersionOnce, hasB2ErrorCode } from '../helpers/b2-cleanup.ts'

const keyId = process.env['B2_APPLICATION_KEY_ID'] ?? ''
const appKey = process.env['B2_APPLICATION_KEY'] ?? ''
const requireCredentials = process.env['B2_INTEGRATION_REQUIRE_CREDENTIALS'] === '1'

const skip = !keyId || !appKey
const bucketPrefix = 'sdk-it-lock-'
const complianceRetentionMs = 15_000
const governanceRetentionMs = 60_000
const retentionToleranceMs = 1_000
const retentionExpirySkewMs = 3_000

const requiredCapabilities: readonly CapabilityValue[] = [
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

if (skip && requireCredentials) {
  throw new Error(
    'B2 integration credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1',
  )
}

type NativeApiVersion = 'v3' | 'v4'

type WireResult<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false
      readonly status: number
      readonly code: string
      readonly message: string
    }

interface UpdateRetentionWireResponse {
  readonly fileName: string
  readonly fileId: FileId
  readonly fileRetention: FileRetentionValue | ReadableFileRetention
}

interface UpdateLegalHoldWireResponse {
  readonly fileName: string
  readonly fileId: FileId
  readonly legalHold: LegalHoldValue
}

function makeBucketName(): string {
  const runId = process.env['GITHUB_RUN_ID']
  const runAttempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1'
  const unique = `${Date.now()}-${globalThis.crypto.randomUUID().slice(0, 8)}`
  if (runId !== undefined && runId !== '') {
    return `${bucketPrefix}${runId}-${runAttempt}-${unique}`
  }
  return `${bucketPrefix}${unique}`
}

function skipIfMissingFeatureCapabilities(
  ctx: TestContext,
  client: B2Client,
  feature: string,
): boolean {
  const check = client.hasCapabilities(requiredCapabilities)
  if (check.ok) return false
  const reason = `${feature} requires B2 capabilities: ${check.missing.join(', ')}`
  console.warn(`[b2 integration] ${feature}: skipped (${reason})`)
  ctx.skip(reason)
  return true
}

function isObjectLockUnavailableError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'unauthorized') ||
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'file_lock_not_enabled')
  )
}

function safeErrorSummary(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err
  const fields: string[] = []
  const maybeError = err as {
    readonly name?: unknown
    readonly status?: unknown
    readonly code?: unknown
  }
  if (typeof maybeError.name === 'string') fields.push(maybeError.name)
  if (typeof maybeError.status === 'number') fields.push(`status=${maybeError.status}`)
  if (typeof maybeError.code === 'string') fields.push(`code=${maybeError.code}`)
  if (fields.length > 0) return fields.join(' ')
  if (err instanceof Error) return err.name
  return 'object'
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntilRetentionExpires(retainUntilTimestamp: number | null): Promise<void> {
  if (retainUntilTimestamp === null) return
  const waitMs = retainUntilTimestamp - Date.now() + retentionExpirySkewMs
  if (waitMs > 0) await delay(waitMs)
}

async function createObjectLockBucket(ctx: TestContext, client: B2Client): Promise<Bucket | null> {
  try {
    return await client.createBucket({
      bucketName: makeBucketName(),
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
  } catch (err) {
    if (isObjectLockUnavailableError(err)) {
      const reason = `file-lock bucket unavailable: ${safeErrorSummary(err)}`
      console.warn(`[b2 integration] Object Lock retention/legal hold: skipped (${reason})`)
      ctx.skip(reason)
      return null
    }
    throw err
  }
}

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

function expectFileRetention(info: FileVersion, expected: FileRetentionValue): void {
  expect(info.fileRetention.isClientAuthorizedToRead).toBe(true)
  expect(info.fileRetention.value).not.toBeNull()
  expect(info.fileRetention.value?.mode).toBe(expected.mode)
  const actualTimestamp = info.fileRetention.value?.retainUntilTimestamp ?? null
  if (expected.retainUntilTimestamp === null) {
    expect(actualTimestamp).toBeNull()
  } else {
    expectTimestampNear(actualTimestamp, expected.retainUntilTimestamp)
  }
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

async function postNativeJson<T>(
  client: B2Client,
  version: NativeApiVersion,
  endpoint: string,
  body: unknown,
): Promise<WireResult<T>> {
  const url = new URL(`/b2api/${version}/${endpoint}`, client.accountInfo.getApiUrl())
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: client.accountInfo.getAuthToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const parsed = (await response.json()) as unknown
  if (response.ok) return { ok: true, body: parsed as T }

  const error = parsed as {
    readonly status?: unknown
    readonly code?: unknown
    readonly message?: unknown
  }
  return {
    ok: false,
    status: typeof error.status === 'number' ? error.status : response.status,
    code: typeof error.code === 'string' ? error.code : 'unknown',
    message: typeof error.message === 'string' ? error.message : '',
  }
}

function expectVersionProbe<T>(endpoint: string, v3: WireResult<T>, v4: WireResult<T>): void {
  expect(v4.ok, `${endpoint} v4 failed: ${formatWireResult(v4)}`).toBe(true)
  if (!v3.ok) {
    expect(v3.status).toBeGreaterThanOrEqual(400)
    expect(v3.code.length).toBeGreaterThan(0)
  }
  console.info(
    `[b2 object lock probe] ${endpoint} v3=${formatWireResult(v3)} v4=${formatWireResult(v4)}`,
  )
}

function formatWireResult<T>(result: WireResult<T>): string {
  if (result.ok) return 'ok'
  return `status=${result.status} code=${result.code}`
}

async function probeWireVersions(client: B2Client, bucket: Bucket): Promise<void> {
  const retentionFileName = 'probe-retention.txt'
  const retentionFile = await uploadText(bucket, retentionFileName, 'retention wire probe')
  const retainUntilTimestamp = Date.now() + governanceRetentionMs
  const retentionRequest = {
    fileName: retentionFileName,
    fileId: retentionFile.fileId,
    fileRetention: {
      mode: RetentionMode.Governance,
      retainUntilTimestamp,
    },
  }

  const retentionV3 = await postNativeJson<UpdateRetentionWireResponse>(
    client,
    'v3',
    'b2_update_file_retention',
    retentionRequest,
  )
  const retentionV4 = await postNativeJson<UpdateRetentionWireResponse>(
    client,
    'v4',
    'b2_update_file_retention',
    {
      ...retentionRequest,
      fileRetention: {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: retainUntilTimestamp + 1_000,
      },
    },
  )
  expectVersionProbe('b2_update_file_retention', retentionV3, retentionV4)
  await bucket.deleteFileVersion(retentionFileName, retentionFile.fileId, {
    bypassGovernance: true,
  })

  const legalHoldFileName = 'probe-legal-hold.txt'
  const legalHoldFile = await uploadText(bucket, legalHoldFileName, 'legal hold wire probe')
  const legalHoldRequest = {
    fileName: legalHoldFileName,
    fileId: legalHoldFile.fileId,
    legalHold: LegalHoldValue.On,
  }

  const legalHoldV3 = await postNativeJson<UpdateLegalHoldWireResponse>(
    client,
    'v3',
    'b2_update_file_legal_hold',
    legalHoldRequest,
  )
  const legalHoldV4 = await postNativeJson<UpdateLegalHoldWireResponse>(
    client,
    'v4',
    'b2_update_file_legal_hold',
    legalHoldRequest,
  )
  expectVersionProbe('b2_update_file_legal_hold', legalHoldV3, legalHoldV4)
  await bucket.updateFileLegalHold(legalHoldFileName, legalHoldFile.fileId, LegalHoldValue.Off)
  await bucket.deleteFileVersion(legalHoldFileName, legalHoldFile.fileId)
}

async function assertLegalHoldSetGetAndDeleteBlock(bucket: Bucket): Promise<void> {
  const fileName = 'legal-hold.txt'
  const file = await uploadText(bucket, fileName, 'legal hold live integration')

  const holdOn = await bucket.updateFileLegalHold(fileName, file.fileId, LegalHoldValue.On)
  expect(holdOn.legalHold).toBe(LegalHoldValue.On)
  expectLegalHold(await bucket.file(fileName).getFileInfo(file.fileId), LegalHoldValue.On)

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId),
    'file_lock_legal_hold_protected',
  )

  const holdOff = await bucket.updateFileLegalHold(fileName, file.fileId, LegalHoldValue.Off)
  expect(holdOff.legalHold).toBe(LegalHoldValue.Off)
  expectLegalHold(await bucket.file(fileName).getFileInfo(file.fileId), LegalHoldValue.Off)
  await bucket.deleteFileVersion(fileName, file.fileId)
}

async function assertGovernanceRetentionSetGetAndBypass(bucket: Bucket): Promise<void> {
  const fileName = 'governance-retention.txt'
  const file = await uploadText(bucket, fileName, 'governance retention live integration')
  const retention = {
    mode: RetentionMode.Governance,
    retainUntilTimestamp: Date.now() + governanceRetentionMs,
  }

  const retained = await bucket.updateFileRetention(fileName, file.fileId, retention)
  expect(retained.fileRetention.mode).toBe(RetentionMode.Governance)
  expectFileRetention(await bucket.file(fileName).getFileInfo(file.fileId), retention)

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId),
    'file_lock_governance_protected',
  )
  await bucket.deleteFileVersion(fileName, file.fileId, { bypassGovernance: true })
}

async function assertComplianceRetentionSetGetAndDeleteBlock(bucket: Bucket): Promise<void> {
  const fileName = 'compliance-retention.txt'
  const file = await uploadText(bucket, fileName, 'compliance retention live integration')
  const retention = {
    mode: RetentionMode.Compliance,
    retainUntilTimestamp: Date.now() + complianceRetentionMs,
  }

  const retained = await bucket.updateFileRetention(fileName, file.fileId, retention)
  expect(retained.fileRetention.mode).toBe(RetentionMode.Compliance)
  expectFileRetention(await bucket.file(fileName).getFileInfo(file.fileId), retention)

  await expectB2ErrorCode(
    bucket.deleteFileVersion(fileName, file.fileId, { bypassGovernance: true }),
    'file_lock_compliance_protected',
  )

  await waitUntilRetentionExpires(retention.retainUntilTimestamp)
  await bucket.deleteFileVersion(fileName, file.fileId, { bypassGovernance: true })
}

async function emptyObjectLockBucket(bucket: Bucket): Promise<void> {
  const deleted = new Set<string>()
  const versions = await bucket.listFileVersions()
  for (const file of versions.files) {
    const fileId = file.fileId
    await clearLegalHoldForDelete(bucket, file.fileName, fileId)
    await clearRetentionForDelete(bucket, file.fileName, fileId)
    await deleteFileVersionOnce(bucket, file.fileName, fileId, deleted, { bypassGovernance: true })
  }
}

async function clearLegalHoldForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
): Promise<void> {
  try {
    await bucket.updateFileLegalHold(fileName, fileId, LegalHoldValue.Off)
  } catch (err) {
    if (!hasB2ErrorCode(err, 'file_not_present') && !hasB2ErrorCode(err, 'no_such_file')) {
      throw err
    }
  }
}

async function clearRetentionForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
): Promise<void> {
  try {
    await bucket.updateFileRetention(
      fileName,
      fileId,
      { mode: null, retainUntilTimestamp: null },
      { bypassGovernance: true },
    )
    return
  } catch (err) {
    if (!hasB2ErrorCode(err, 'file_lock_compliance_protected')) throw err
  }

  const info = await bucket.file(fileName).getFileInfo(fileId)
  await waitUntilRetentionExpires(info.fileRetention.value?.retainUntilTimestamp ?? null)
  await bucket.updateFileRetention(
    fileName,
    fileId,
    { mode: null, retainUntilTimestamp: null },
    { bypassGovernance: true },
  )
}

async function deleteObjectLockBucketIfPresent(bucket: Bucket): Promise<void> {
  await emptyObjectLockBucket(bucket)
  await bucket.delete()
}

describe.skipIf(skip)('B2 Object Lock integration', () => {
  it('sets, gets, probes, and deletes Object Lock file versions', async (ctx) => {
    const feature = 'Object Lock retention/legal hold'
    const client = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await client.authorize()
    if (skipIfMissingFeatureCapabilities(ctx, client, feature)) return

    const bucket = await createObjectLockBucket(ctx, client)
    if (bucket === null) return

    try {
      await probeWireVersions(client, bucket)
      await assertLegalHoldSetGetAndDeleteBlock(bucket)
      await assertGovernanceRetentionSetGetAndBypass(bucket)
      await assertComplianceRetentionSetGetAndDeleteBlock(bucket)
    } finally {
      await deleteObjectLockBucketIfPresent(bucket)
    }
  })
})
