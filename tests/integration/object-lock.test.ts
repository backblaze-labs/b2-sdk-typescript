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
import type { FileId } from '../../src/types/ids.ts'
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
const probeAttempts = 3
const probeTimeoutMs = 15_000
const probeRetryDelayMs = 500
const protectedDeleteErrorCode = 'access_denied'
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

async function postNativeJson<T>(
  client: B2Client,
  version: NativeApiVersion,
  endpoint: string,
  body: unknown,
): Promise<WireResult<T>> {
  let lastResult: WireResult<T> | null = null
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    const result = await postNativeJsonOnce<T>(client, version, endpoint, body)
    if (result.ok || !isTransientWireFailure(result) || attempt === probeAttempts) return result
    lastResult = result
    await delay(probeRetryDelayMs * attempt)
  }
  return (
    lastResult ?? {
      ok: false,
      status: 0,
      code: 'probe_not_attempted',
      message: 'probe exhausted without an attempt result',
    }
  )
}

async function postNativeJsonOnce<T>(
  client: B2Client,
  version: NativeApiVersion,
  endpoint: string,
  body: unknown,
): Promise<WireResult<T>> {
  const url = new URL(`/b2api/${version}/${endpoint}`, client.accountInfo.getApiUrl())
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), probeTimeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const parsed = parseJsonBody(await response.text())
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
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: controller.signal.aborted ? 'request_timeout' : 'network_error',
      message: safeErrorSummary(err),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseJsonBody(text: string): unknown {
  if (text.length === 0) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { code: 'non_json_response', message: text }
  }
}

function isTransientWireFailure<T>(result: WireResult<T>): boolean {
  return (
    !result.ok &&
    (result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500)
  )
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
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

  await expectB2ErrorCode(bucket.deleteFileVersion(fileName, file.fileId), protectedDeleteErrorCode)

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

  await expectB2ErrorCode(bucket.deleteFileVersion(fileName, file.fileId), protectedDeleteErrorCode)
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
    protectedDeleteErrorCode,
  )
  await deleteAfterRetentionExpires(bucket, fileName, file.fileId, retention.retainUntilTimestamp)
}

async function deleteAfterRetentionExpires(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
  retainUntilTimestamp: number,
): Promise<void> {
  await delay(Math.max(0, retainUntilTimestamp - Date.now() + retentionToleranceMs))

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await bucket.deleteFileVersion(fileName, fileId)
      return
    } catch (err) {
      if (!hasB2ErrorCode(err, protectedDeleteErrorCode) || attempt === 10) throw err
      await delay(1_000)
    }
  }
}

describe.skipIf(skip)('B2 Object Lock integration', () => {
  let client: B2Client | null = null
  let bucket: Bucket | null = null
  let setupSkipReason: string | null = null

  beforeAll(async () => {
    const liveClient = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    client = liveClient
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

  it('probes retention and legal-hold v3/v4 wire versions', async (ctx) => {
    const liveClient = requireObjectLockClient(ctx, client, setupSkipReason)
    const liveBucket = requireObjectLockBucket(ctx, bucket, setupSkipReason)
    if (liveClient === null || liveBucket === null) return

    await probeWireVersions(liveClient, liveBucket)
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

function requireObjectLockClient(
  ctx: TestContext,
  client: B2Client | null,
  setupSkipReason: string | null,
): B2Client | null {
  if (skipIfSetupUnavailable(ctx, setupSkipReason)) return null
  if (client !== null) return client
  throw new Error('Object Lock client was not initialized')
}

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
