/**
 * Integration tests against a real Backblaze B2 account.
 *
 * Requires env vars:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 *
 * These tests create a temporary bucket, upload/download files,
 * exercise file operations, and clean up after themselves.
 */

import { afterAll, beforeAll, describe, expect, it, type TestContext, vi } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { BadBucketIdError } from '../../src/errors/index.ts'
import { FetchTransport, type HttpRequest, type HttpTransport } from '../../src/http/transport.ts'
import { RawClient } from '../../src/raw/index.ts'
import { sha1Hex } from '../../src/streams/hash.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { Capability, type Capability as CapabilityValue } from '../../src/types/auth.ts'
import { SSE_B2 } from '../../src/types/encryption.ts'
import { accountId, type LargeFileId } from '../../src/types/ids.ts'
import { LegalHoldValue, RetentionMode } from '../../src/types/lock.ts'
import { uploadPartWithFreshUrl } from '../../src/upload/retry.ts'
import { deleteFileVersionOnce, hasB2ErrorCode } from '../helpers/b2-cleanup.ts'

const keyId = process.env.B2_APPLICATION_KEY_ID ?? ''
const appKey = process.env.B2_APPLICATION_KEY ?? ''
const requireCredentials = process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS === '1'

const skip = !keyId || !appKey
const currentBucketPrefix = 'sdk-it-'
const legacyBucketPrefix = 'sdk-test-'
const staleBucketAgeMs = 60 * 60 * 1000
const setupStepTimeoutMs = 60 * 1000
const cleanupAttempts = 3
const cleanupRetryDelayMs = 250

if (skip && requireCredentials) {
  throw new Error(
    'B2 integration credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1',
  )
}

function makeBucketName(label?: string): string {
  const runId = process.env.GITHUB_RUN_ID
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  const now = Date.now()
  const suffix = label === undefined ? `${now}` : `${label}-${now}`
  if (runId !== undefined && runId !== '') {
    return `${currentBucketPrefix}${runId}-${runAttempt}-${suffix}`
  }
  return `${currentBucketPrefix}${suffix}`
}

function recordingLiveTransport(requests: HttpRequest[]): HttpTransport {
  const inner = new FetchTransport()
  return {
    send(request) {
      requests.push(request)
      return inner.send(request)
    },
  }
}

function endpointName(url: string): string {
  return new URL(url).pathname.split('/').at(-1) ?? ''
}

function isIntegrationBucketName(name: string): boolean {
  return name.startsWith(currentBucketPrefix) || name.startsWith(legacyBucketPrefix)
}

function bucketTimestamp(name: string): number | null {
  const matches = [...name.matchAll(/\d{13}/g)]
  const last = matches.at(-1)?.[0]
  if (last === undefined) return null
  const timestamp = Number(last)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

function isStaleIntegrationBucket(name: string, now = Date.now()): boolean {
  if (!isIntegrationBucketName(name)) return false
  const createdAt = bucketTimestamp(name)
  return createdAt !== null && now - createdAt > staleBucketAgeMs
}

async function emptyBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  await cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors)

  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileNames()) {
    await deleteFileVersionForCleanup(bucket, file.fileName, file.fileId, deleted, cleanupErrors)
  }

  const versions = await bucket.listFileVersions()
  for (const fv of versions.files) {
    await deleteFileVersionForCleanup(bucket, fv.fileName, fv.fileId, deleted, cleanupErrors)
  }

  throwCleanupErrors('empty bucket', cleanupErrors)
}

async function emptyObjectLockBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  await cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors)

  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileVersions()) {
    await clearLegalHoldForDelete(bucket, file.fileName, file.fileId)
    await clearRetentionForDelete(bucket, file.fileName, file.fileId)
    await deleteFileVersionForCleanup(bucket, file.fileName, file.fileId, deleted, cleanupErrors, {
      bypassGovernance: true,
    })
  }

  throwCleanupErrors('empty Object Lock bucket', cleanupErrors)
}

async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

async function deleteObjectLockBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyObjectLockBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

async function cancelUnfinishedLargeFiles(
  bucket: Bucket,
  namePrefix?: string,
  cleanupErrors: unknown[] = [],
): Promise<void> {
  for await (const file of bucket.paginateUnfinishedLargeFiles(
    namePrefix === undefined ? undefined : { namePrefix },
  )) {
    const cancelled = await retryCleanupStep(
      'cancel unfinished large file',
      bucket,
      file.fileName,
      file.fileId,
      () => bucket.cancelLargeFile(file.fileId),
    )
    if (!cancelled.ok) cleanupErrors.push(cancelled.err)
  }
}

async function clearLegalHoldForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
): Promise<void> {
  await retryCleanupStep('clear legal hold', bucket, fileName, fileId, () =>
    bucket.updateFileLegalHold(fileName, fileId, LegalHoldValue.Off),
  )
}

async function clearRetentionForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
): Promise<void> {
  await retryCleanupStep('clear retention', bucket, fileName, fileId, () =>
    bucket.updateFileRetention(
      fileName,
      fileId,
      { mode: null, retainUntilTimestamp: null },
      { bypassGovernance: true },
    ),
  )
}

async function deleteFileVersionForCleanup(
  bucket: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
  deleted: Set<string>,
  cleanupErrors: unknown[],
  options?: Parameters<Bucket['deleteFileVersion']>[2],
): Promise<void> {
  const deletedVersion = await retryCleanupStep(
    'delete file version',
    bucket,
    fileName,
    fileId,
    () => deleteFileVersionOnce(bucket, fileName, fileId, deleted, options),
  )
  if (!deletedVersion.ok) cleanupErrors.push(deletedVersion.err)
}

async function retryCleanupStep(
  action: string,
  bucket: Bucket,
  fileName: string,
  fileId: string,
  fn: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
    try {
      await fn()
      return { ok: true }
    } catch (err) {
      lastError = err
      logCleanupFailure(
        `${action} attempt=${attempt}/${cleanupAttempts}`,
        bucket,
        fileName,
        fileId,
        err,
      )
      if (attempt < cleanupAttempts) await delay(cleanupRetryDelayMs)
    }
  }
  return { ok: false, err: lastError }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function throwCleanupErrors(action: string, errors: readonly unknown[]): void {
  if (errors.length === 0) return
  throw new AggregateError(errors, `${action} failed for ${errors.length} cleanup operation(s)`)
}

function logCleanupFailure(
  action: string,
  bucket: Bucket,
  fileName: string,
  fileId: string,
  err: unknown,
): void {
  console.warn(
    `[b2 integration cleanup] ${action} failed bucket=${bucket.id} fileName=${fileName} fileId=${fileId} error=${safeErrorSummary(err)}`,
  )
}

function makeBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = (seed + i * 31) & 0xff
  }
  return bytes
}

async function readAllBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  for (let i = 0; i < actual.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`Byte mismatch at offset ${i}: expected ${expected[i]}, got ${actual[i]}`)
    }
  }
}

async function uploadRawPart(
  client: B2Client,
  fileId: LargeFileId,
  fileName: string,
  partNumber: number,
  data: Uint8Array,
): Promise<string> {
  const contentSha1 = await sha1Hex(data)
  const part = await uploadPartWithFreshUrl(client.raw, client.accountInfo, fileId, {
    fileName,
    partNumber,
    data,
    contentLength: data.byteLength,
    contentSha1,
    retryResponseBodyFailures: true,
  })
  expect(part.contentSha1).toBe(contentSha1)
  return part.contentSha1
}

function safeErrorSummary(err: unknown): string {
  // Deliberately omit err.message from live-service logs. SDK errors are expected
  // to redact credentials, but setup/cleanup paths can see arbitrary thrown
  // values, so CI logs only include structural error fields.
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

function logSetup(message: string): void {
  console.info(`[b2 integration setup] ${message}`)
}

function logFeatureSkip(feature: string, reason: string): void {
  console.warn(`[b2 integration] ${feature}: skipped (${reason})`)
}

function requireFeatureCapabilities(
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): void {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return
  throw new Error(`${feature} requires B2 capabilities: ${check.missing.join(', ')}`)
}

function skipIfMissingFeatureCapabilities(
  ctx: TestContext,
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): void {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return
  const reason = `missing capabilities: ${check.missing.join(', ')}`
  logFeatureSkip(feature, reason)
  ctx.skip(reason)
}

function isObjectLockUnavailableError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'unauthorized') ||
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'file_lock_not_enabled')
  )
}

async function withRecommendedPartSize<T>(
  client: B2Client,
  partSize: number,
  fn: () => Promise<T>,
): Promise<T> {
  const recommendedPartSize = vi
    .spyOn(client.accountInfo, 'getRecommendedPartSize')
    .mockReturnValue(partSize)
  try {
    return await fn()
  } finally {
    recommendedPartSize.mockRestore()
  }
}

async function setupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const operation = Promise.resolve().then(fn)
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      reject(
        new Error(`B2 integration setup step "${name}" timed out after ${setupStepTimeoutMs}ms`),
      )
    }, setupStepTimeoutMs)
  })

  logSetup(`${name}: start`)
  try {
    const result = await Promise.race([operation, timeoutPromise])
    logSetup(`${name}: ok (${Math.round(performance.now() - start)}ms)`)
    return result
  } catch (err) {
    logSetup(`${name}: failed after ${Math.round(performance.now() - start)}ms`)
    console.error(`[b2 integration setup] ${name}: ${safeErrorSummary(err)}`)
    throw err
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (timedOut) {
      void operation.catch((err) => {
        console.warn(
          `[b2 integration setup] ${name}: underlying operation rejected after timeout (${safeErrorSummary(err)})`,
        )
      })
    }
  }
}

async function sweepStaleIntegrationBuckets(existing: readonly Bucket[]): Promise<void> {
  const now = Date.now()
  const staleBuckets = existing.filter((bucket) => isStaleIntegrationBucket(bucket.name, now))
  let deletedCount = 0
  let skippedCount = 0

  logSetup(`stale bucket sweep: ${staleBuckets.length} candidate(s) among ${existing.length}`)

  for (const bucket of staleBuckets) {
    const start = performance.now()
    try {
      await deleteBucketIfPresent(bucket)
      deletedCount += 1
      logSetup(
        `delete stale bucket ${bucket.name}: ok (${Math.round(performance.now() - start)}ms)`,
      )
    } catch (err) {
      skippedCount += 1
      console.warn(
        `[b2 integration setup] delete stale bucket ${bucket.name}: skipped after ${Math.round(
          performance.now() - start,
        )}ms (${safeErrorSummary(err)})`,
      )
    }
  }

  logSetup(`stale bucket sweep: deleted ${deletedCount}, skipped ${skippedCount}`)
}

describe('B2 integration cleanup safety', () => {
  it('does not use Object Lock bypass cleanup for prefix-discovered stale buckets', async () => {
    const calls = {
      updateFileLegalHold: 0,
      updateFileRetention: 0,
      bypassDelete: 0,
    }
    const fakeBucket = {
      id: 'bucket-stale',
      name: `${currentBucketPrefix}${Date.now() - staleBucketAgeMs - 1}`,
      async *paginateUnfinishedLargeFiles() {},
      async *paginateFileNames() {
        yield { fileName: 'locked.txt', fileId: 'file-locked' }
      },
      async listFileVersions() {
        return { files: [], nextFileName: null, nextFileId: null }
      },
      async deleteFileVersion(
        _fileName: string,
        _fileId: string,
        options?: { bypassGovernance?: boolean },
      ) {
        if (options?.bypassGovernance === true) calls.bypassDelete += 1
        throw { status: 400, code: 'file_lock_governance_protected' }
      },
      async updateFileLegalHold() {
        calls.updateFileLegalHold += 1
      },
      async updateFileRetention() {
        calls.updateFileRetention += 1
      },
      async delete() {
        throw { status: 400, code: 'cannot_delete_non_empty_bucket' }
      },
    } as unknown as Bucket

    await sweepStaleIntegrationBuckets([fakeBucket])

    expect(calls).toEqual({
      updateFileLegalHold: 0,
      updateFileRetention: 0,
      bypassDelete: 0,
    })
  })

  it('continues Object Lock cleanup after one version fails', async () => {
    const deleted: string[] = []
    const fakeBucket = {
      id: 'bucket-lock',
      name: makeBucketName('lock-cleanup'),
      async *paginateUnfinishedLargeFiles() {},
      async *paginateFileVersions() {
        yield { fileName: 'blocked.txt', fileId: 'blocked' }
        yield { fileName: 'open.txt', fileId: 'open' }
      },
      async updateFileLegalHold(_fileName: string, fileId: string) {
        if (fileId === 'blocked') throw { status: 503, code: 'service_unavailable' }
      },
      async updateFileRetention() {},
      async deleteFileVersion(_fileName: string, fileId: string) {
        if (fileId === 'blocked') throw { status: 400, code: 'file_lock_governance_protected' }
        deleted.push(fileId)
      },
    } as unknown as Bucket

    await expect(emptyObjectLockBucket(fakeBucket)).rejects.toThrow(
      /empty Object Lock bucket failed/,
    )
    expect(deleted).toEqual(['open'])
  })
})

describe.skipIf(skip)('B2 integration', () => {
  let client: B2Client
  let bucket: Bucket
  const bucketName = makeBucketName()

  beforeAll(async () => {
    client = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await setupStep('authorize', () => client.authorize())

    // Defensive: sweep stale integration buckets from prior runs that crashed
    // before their afterAll cleanup. Keep this age-gated so another branch's
    // live integration run cannot have its bucket removed mid-test.
    const existing = await setupStep('list buckets', () => client.listBuckets())
    await setupStep('sweep stale integration buckets', () => sweepStaleIntegrationBuckets(existing))

    bucket = await setupStep(`create bucket ${bucketName}`, () =>
      client.createBucket({
        bucketName,
        bucketType: 'allPrivate',
      }),
    )
  })

  afterAll(async () => {
    if (!bucket) return
    await deleteBucketIfPresent(bucket)
  })

  it('authorizes successfully', () => {
    expect(client.accountInfo.getAccountId()).toBeTruthy()
    expect(client.accountInfo.getApiUrl()).toContain('backblazeb2.com')
  })

  it('created the test bucket', () => {
    expect(bucket.name).toBe(bucketName)
    expect(bucket.id).toBeTruthy()
  })

  it('uses v4 POST JSON for raw read/list endpoints against live B2', async (ctx) => {
    const feature = 'raw v4 POST JSON contract'
    skipIfMissingFeatureCapabilities(ctx, client, feature, [
      Capability.WriteFiles,
      Capability.ListFiles,
      Capability.ReadFiles,
      Capability.ListKeys,
    ])

    const seenRequests: HttpRequest[] = []
    const raw = new RawClient({ transport: recordingLiveTransport(seenRequests) })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const fileName = `raw-v4-contract-${Date.now()}.txt`
    const data = new TextEncoder().encode('raw v4 contract')
    const uploaded = await bucket.upload({
      fileName,
      source: new BufferSource(data),
      contentType: 'text/plain',
    })

    try {
      const uploadUrl = await raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
      expect(uploadUrl.uploadUrl).toBeTruthy()
      expect(uploadUrl.authorizationToken).toBeTruthy()

      const info = await raw.getFileInfo(apiUrl, authToken, { fileId: uploaded.fileId })
      expect(info.fileId).toBe(uploaded.fileId)

      const names = await raw.listFileNames(apiUrl, authToken, {
        bucketId: bucket.id,
        prefix: fileName,
        maxFileCount: 1,
      })
      expect(names.files.some((file) => file.fileName === fileName)).toBe(true)

      const keys = await raw.listKeys(apiUrl, authToken, {
        accountId: accountId(client.accountInfo.getAccountId()),
        maxKeyCount: 1,
      })
      expect(Array.isArray(keys.keys)).toBe(true)

      const contractEndpoints = new Set([
        'b2_get_upload_url',
        'b2_get_file_info',
        'b2_list_file_names',
        'b2_list_keys',
      ])
      const contractRequests = seenRequests.filter((request) =>
        contractEndpoints.has(endpointName(request.url)),
      )

      expect(
        contractRequests.map((request) => ({
          endpoint: endpointName(request.url),
          pathname: new URL(request.url).pathname,
          method: request.method,
          contentType: request.headers?.['Content-Type'],
        })),
      ).toEqual([
        {
          endpoint: 'b2_get_upload_url',
          pathname: '/b2api/v4/b2_get_upload_url',
          method: 'POST',
          contentType: 'application/json',
        },
        {
          endpoint: 'b2_get_file_info',
          pathname: '/b2api/v4/b2_get_file_info',
          method: 'POST',
          contentType: 'application/json',
        },
        {
          endpoint: 'b2_list_file_names',
          pathname: '/b2api/v4/b2_list_file_names',
          method: 'POST',
          contentType: 'application/json',
        },
        {
          endpoint: 'b2_list_keys',
          pathname: '/b2api/v4/b2_list_keys',
          method: 'POST',
          contentType: 'application/json',
        },
      ])
    } finally {
      await bucket.deleteFileVersion(fileName, uploaded.fileId).catch(() => {})
    }
  })

  it('lists unfinished large files with inclusive startFileId and resolved auto content type', async () => {
    const first = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'unfinished-order-z.bin',
        contentType: 'b2/x-auto',
      },
    )
    const second = await client.raw
      .startLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
        bucketId: bucket.id,
        fileName: 'unfinished-order-a.bin',
        contentType: 'b2/x-auto',
      })
      .catch(async (err: unknown) => {
        await client.raw
          .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
            fileId: first.fileId,
          })
          .catch(() => {})
        throw err
      })

    try {
      const listing = await client.raw.listUnfinishedLargeFiles(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        {
          bucketId: bucket.id,
          namePrefix: 'unfinished-order-',
          maxFileCount: 100,
        },
      )
      const ids = listing.files.map((file) => file.fileId)
      expect(ids.indexOf(first.fileId)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(second.fileId)).toBeGreaterThanOrEqual(0)
      expect(listing.files.find((file) => file.fileId === first.fileId)?.contentType).toBe(
        'application/octet-stream',
      )

      const fromFirst = await client.raw.listUnfinishedLargeFiles(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        {
          bucketId: bucket.id,
          namePrefix: 'unfinished-order-',
          startFileId: first.fileId,
          maxFileCount: 1,
        },
      )
      expect(fromFirst.files[0]?.fileId).toBe(first.fileId)
    } finally {
      await client.raw
        .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
          fileId: first.fileId,
        })
        .catch(() => {})
      await client.raw
        .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
          fileId: second.fileId,
        })
        .catch(() => {})
    }
  })

  it('uploads and finishes a multipart file against live B2', async () => {
    const partSize = client.accountInfo.getAbsoluteMinimumPartSize()
    const data = makeBytes(partSize + 1024, 17)
    const fileName = 'large-finished.bin'
    let finished = false

    try {
      const file = await withRecommendedPartSize(client, partSize, () =>
        bucket.upload({
          fileName,
          source: new BufferSource(data),
          contentType: 'application/octet-stream',
          partSize,
          concurrency: 2,
        }),
      )
      finished = true

      expect(file.fileName).toBe(fileName)
      expect(file.action).toBe('upload')
      expect(file.contentLength).toBe(data.byteLength)

      const downloaded = await bucket.download(fileName)
      expectBytesEqual(await readAllBytes(downloaded.body), data)
    } finally {
      if (!finished) await cancelUnfinishedLargeFiles(bucket, fileName)
    }
  })

  it('resumes an explicit unfinished multipart upload and finishes it', async () => {
    const feature = 'explicit multipart resume'
    requireFeatureCapabilities(client, feature, [
      Capability.ListFiles,
      Capability.ReadFiles,
      Capability.WriteFiles,
      Capability.ReadFileRetentions,
    ])

    const partSize = client.accountInfo.getAbsoluteMinimumPartSize()
    const data = makeBytes(partSize + 2048, 29)
    const fileName = 'large-resume.bin'
    // Keep explicit resume independent of bucket-default retention readability
    // while still exercising the SDK's fail-closed retention verification.
    const fileRetention = { mode: null, retainUntilTimestamp: null }
    const started = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName,
        contentType: 'application/octet-stream',
        fileInfo: {},
        serverSideEncryption: SSE_B2,
      },
    )
    let finished = false

    try {
      const firstPartSha1 = await uploadRawPart(
        client,
        started.fileId,
        fileName,
        1,
        data.subarray(0, partSize),
      )
      const reusedParts: number[] = []
      const reusedPartSha1s: string[] = []

      const file = await withRecommendedPartSize(client, partSize, () =>
        bucket.upload({
          fileName,
          source: new BufferSource(data),
          contentType: 'application/octet-stream',
          partSize,
          concurrency: 2,
          resumeFileId: started.fileId,
          fileRetention,
          serverSideEncryption: SSE_B2,
          onResumePartReused: (event) => {
            reusedParts.push(event.partNumber)
            reusedPartSha1s.push(event.contentSha1)
          },
        }),
      )
      finished = true

      expect(file.contentLength).toBe(data.byteLength)
      expect(reusedParts).toEqual([1])
      expect(reusedPartSha1s).toEqual([firstPartSha1])

      const downloaded = await bucket.download(fileName)
      expectBytesEqual(await readAllBytes(downloaded.body), data)
    } finally {
      if (!finished) {
        await client.raw
          .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
            fileId: started.fileId,
          })
          .catch(() => {})
        await cancelUnfinishedLargeFiles(bucket, fileName)
      }
    }
  })

  it('streams a multipart upload and downloads it with parallel ranges', async () => {
    const partSize = client.accountInfo.getAbsoluteMinimumPartSize()
    const data = makeBytes(partSize + 4096, 43)
    const fileName = 'streamed-ranged.bin'
    const { writable, done } = bucket.file(fileName).createWriteStream({
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 2,
    })
    const writer = writable.getWriter()
    let finished = false

    try {
      await writer.write(data.subarray(0, Math.floor(partSize / 2)))
      await writer.write(data.subarray(Math.floor(partSize / 2), partSize + 111))
      await writer.write(data.subarray(partSize + 111))
      await writer.close()
      const file = await done
      finished = true

      expect(file.fileName).toBe(fileName)
      expect(file.contentLength).toBe(data.byteLength)

      const stream = bucket.file(fileName).createReadStream(file.fileId, file.contentLength, {
        rangeSize: Math.floor(partSize / 3),
        concurrency: 2,
      })
      expectBytesEqual(await readAllBytes(stream), data)
    } finally {
      if (!finished) await cancelUnfinishedLargeFiles(bucket, fileName)
    }
  })

  it('uploads and reads an SSE-B2 encrypted file when supported', async (ctx) => {
    const feature = 'SSE-B2 upload/download'
    skipIfMissingFeatureCapabilities(ctx, client, feature, [
      Capability.WriteFiles,
      Capability.ReadFiles,
    ])

    const fileName = 'sse-b2.txt'
    const data = new TextEncoder().encode('sse-b2 live integration')
    const file = await bucket.upload({
      fileName,
      source: new BufferSource(data),
      contentType: 'text/plain',
      serverSideEncryption: SSE_B2,
    })

    expect(file.serverSideEncryption).toEqual(SSE_B2)
    const head = await bucket.head(fileName)
    expect(head.headers.serverSideEncryption).toEqual(SSE_B2)
    const downloaded = await bucket.download(fileName)
    expectBytesEqual(await readAllBytes(downloaded.body), data)
  })

  it('updates file retention and legal hold in a file-lock bucket when permitted', async (ctx) => {
    const feature = 'Object Lock retention/legal hold'
    skipIfMissingFeatureCapabilities(ctx, client, feature, [
      Capability.WriteBuckets,
      Capability.DeleteBuckets,
      Capability.ListFiles,
      Capability.WriteFiles,
      Capability.DeleteFiles,
      Capability.ReadFileLegalHolds,
      Capability.WriteFileLegalHolds,
      Capability.ReadFileRetentions,
      Capability.WriteFileRetentions,
      Capability.BypassGovernance,
    ])

    let lockBucket: Bucket
    try {
      lockBucket = await client.createBucket({
        bucketName: makeBucketName('lock'),
        bucketType: 'allPrivate',
        fileLockEnabled: true,
      })
    } catch (err) {
      if (isObjectLockUnavailableError(err)) {
        const reason = `file-lock bucket unavailable: ${safeErrorSummary(err)}`
        logFeatureSkip(feature, reason)
        ctx.skip(reason)
      }
      throw err
    }

    try {
      const fileName = 'object-lock.txt'
      const object = lockBucket.file(fileName)
      const file = await object.upload({
        source: new BufferSource(new TextEncoder().encode('object lock live integration')),
        contentType: 'text/plain',
      })

      const holdOn = await object.setLegalHold(file.fileId, LegalHoldValue.On)
      expect(holdOn.legalHold).toBe(LegalHoldValue.On)
      const holdOff = await object.setLegalHold(file.fileId, LegalHoldValue.Off)
      expect(holdOff.legalHold).toBe(LegalHoldValue.Off)

      const retainUntilTimestamp = Date.now() + 60_000
      const retained = await object.setRetention(file.fileId, {
        mode: RetentionMode.Governance,
        retainUntilTimestamp,
      })
      expect(retained.fileRetention.mode).toBe(RetentionMode.Governance)
      expect(retained.fileRetention.retainUntilTimestamp).not.toBeNull()
      expect(
        Math.abs((retained.fileRetention.retainUntilTimestamp ?? 0) - retainUntilTimestamp),
      ).toBeLessThanOrEqual(1000)

      const cleared = await object.setRetention(
        file.fileId,
        { mode: null, retainUntilTimestamp: null },
        { bypassGovernance: true },
      )
      expect(cleared.fileRetention).toEqual({ mode: null, retainUntilTimestamp: null })
    } finally {
      await deleteObjectLockBucketIfPresent(lockBucket)
    }
  })

  it('rejects upload with an invalid upload authorization token', async () => {
    const data = new TextEncoder().encode('this upload should be rejected')
    const uploadUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )

    let uploadError: unknown
    try {
      await client.raw.uploadFile(
        uploadUrl.uploadUrl,
        {
          authorization: `${uploadUrl.authorizationToken}-stale`,
          fileName: 'invalid-upload-token.txt',
          contentType: 'text/plain',
          contentLength: data.byteLength,
          contentSha1: await sha1Hex(data),
        },
        data,
      )
    } catch (err) {
      uploadError = err
    }

    expect(
      hasB2ErrorCode(uploadError, 'bad_auth_token') ||
        hasB2ErrorCode(uploadError, 'expired_auth_token') ||
        hasB2ErrorCode(uploadError, 'unauthorized'),
    ).toBe(true)
  })

  it('uploads a small file', async () => {
    const data = new TextEncoder().encode('integration test content')
    const file = await bucket.upload({
      fileName: 'test-small.txt',
      source: new BufferSource(data),
      contentType: 'text/plain',
    })

    expect(file.fileName).toBe('test-small.txt')
    expect(file.contentLength).toBe(data.byteLength)
    expect(file.action).toBe('upload')
    expect(file.contentType).toBe('text/plain')
  })

  it('downloads the file by name', async () => {
    const result = await bucket.download('test-small.txt')
    const combined = await readAllBytes(result.body)

    expect(new TextDecoder().decode(combined)).toBe('integration test content')
  })

  it('lists files in the bucket', async () => {
    const listing = await bucket.listFileNames()
    expect(listing.files.length).toBeGreaterThanOrEqual(1)
    const names = listing.files.map((f) => f.fileName)
    expect(names).toContain('test-small.txt')
  })

  it('gets file info', async () => {
    const listing = await bucket.listFileNames()
    const file = listing.files.find((f) => f.fileName === 'test-small.txt')
    expect(file).toBeDefined()
    if (!file) return

    const obj = bucket.file('test-small.txt')
    const info = await obj.getFileInfo(file.fileId)
    expect(info.fileName).toBe('test-small.txt')
    expect(info.contentType).toBe('text/plain')
  })

  it('copies a file', async () => {
    const listing = await bucket.listFileNames()
    const original = listing.files.find((f) => f.fileName === 'test-small.txt')
    expect(original).toBeDefined()
    if (!original) return

    const copied = await bucket.copyFile({
      sourceFileId: original.fileId,
      fileName: 'test-copied.txt',
    })

    expect(copied.fileName).toBe('test-copied.txt')
    expect(copied.contentLength).toBe(original.contentLength)
  })

  it('hides a file', async () => {
    await bucket.upload({
      fileName: 'to-hide.txt',
      source: new BufferSource(new TextEncoder().encode('hide me')),
    })

    const hidden = await bucket.hideFile('to-hide.txt')
    expect(hidden.action).toBe('hide')
    expect(hidden.fileName).toBe('to-hide.txt')

    const listing = await bucket.listFileNames()
    const names = listing.files.map((f) => f.fileName)
    expect(names).not.toContain('to-hide.txt')
  })

  it('uploads multiple files and iterates with async generator', async () => {
    const prefix = 'iter-test/'
    for (let i = 0; i < 5; i++) {
      await bucket.upload({
        fileName: `${prefix}file-${i}.txt`,
        source: new BufferSource(new TextEncoder().encode(`content-${i}`)),
      })
    }

    const collected: string[] = []
    for await (const file of bucket.paginateFileNames({ prefix })) {
      collected.push(file.fileName)
    }
    expect(collected.length).toBe(5)
  })

  it('updates bucket type', async () => {
    const updated = await bucket.update({ bucketType: 'allPublic' })
    expect(updated.bucketType).toBe('allPublic')

    const reverted = await bucket.update({ bucketType: 'allPrivate' })
    expect(reverted.bucketType).toBe('allPrivate')
  })

  it('gets download authorization', async () => {
    const auth = await bucket.getDownloadAuthorization('test-', 3600)
    expect(auth.bucketId).toBe(bucket.id)
    expect(auth.authorizationToken).toBeTruthy()
  })
})
