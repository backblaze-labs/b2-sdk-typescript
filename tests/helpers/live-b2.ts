import { expect, type TestContext, vi } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import type { B2Client } from '../../src/client.ts'
import { BadBucketIdError } from '../../src/errors/index.ts'
import { sha1Hex } from '../../src/streams/hash.ts'
import type { Capability as CapabilityValue } from '../../src/types/auth.ts'
import type { LargeFileId } from '../../src/types/ids.ts'
import { type FileRetentionValue, LegalHoldValue, RetentionMode } from '../../src/types/lock.ts'
import { uploadPartWithFreshUrl } from '../../src/upload/retry.ts'
import { deleteFileVersionOnce, hasB2ErrorCode } from './b2-cleanup.ts'

export const keyId = process.env.B2_APPLICATION_KEY_ID ?? ''
export const appKey = process.env.B2_APPLICATION_KEY ?? ''
export const skipB2Integration = !keyId || !appKey
export const currentBucketPrefix = 'sdk-it-'
export const legacyBucketPrefix = 'sdk-test-'
export const staleBucketAgeMs = 60 * 60 * 1000
export const setupStepTimeoutMs = 60 * 1000
export const cleanupAttempts = 3
export const cleanupRetryDelayMs = 250
export const directFetchTimeoutMs = 30 * 1000
export const complianceCleanupClockSkewMs = 2 * 1000
export const complianceCleanupMaxWaitMs = 30 * 1000
export const complianceCleanupRetryBudgetMs = 30 * 1000
export const complianceCleanupRetryDelayMs = 1000

const complianceProtectedErrorCode = 'file_lock_compliance_protected'

const requireCredentials = process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS === '1'

export function requireB2IntegrationCredentials(): void {
  if (skipB2Integration && requireCredentials) {
    throw new Error(
      'B2 integration credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1',
    )
  }
}

export function makeBucketName(label?: string): string {
  const runId = process.env.GITHUB_RUN_ID
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  const now = Date.now()
  const suffix = label === undefined ? `${now}` : `${label}-${now}`
  if (runId !== undefined && runId !== '') {
    return `${currentBucketPrefix}${runId}-${runAttempt}-${suffix}`
  }
  return `${currentBucketPrefix}${suffix}`
}

export function isIntegrationBucketName(name: string): boolean {
  return name.startsWith(currentBucketPrefix) || name.startsWith(legacyBucketPrefix)
}

export function bucketTimestamp(name: string): number | null {
  const matches = [...name.matchAll(/\d{13}/g)]
  const last = matches.at(-1)?.[0]
  if (last === undefined) return null
  const timestamp = Number(last)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

export function isStaleIntegrationBucket(name: string, now = Date.now()): boolean {
  if (!isIntegrationBucketName(name)) return false
  const createdAt = bucketTimestamp(name)
  return createdAt !== null && now - createdAt > staleBucketAgeMs
}

export async function emptyBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  await retryCleanupPhase('cancel unfinished large files', bucket, cleanupErrors, () =>
    cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors),
  )

  const deleted = new Set<string>()
  await retryCleanupPhase('delete latest file versions', bucket, cleanupErrors, async () => {
    for await (const file of bucket.paginateFileNames()) {
      await deleteFileVersionForCleanup(bucket, file.fileName, file.fileId, deleted, cleanupErrors)
    }
  })

  await retryCleanupPhase('delete all file versions', bucket, cleanupErrors, async () => {
    const versions = await bucket.listFileVersions()
    for (const fv of versions.files) {
      await deleteFileVersionForCleanup(bucket, fv.fileName, fv.fileId, deleted, cleanupErrors)
    }
  })

  throwCleanupErrors('empty bucket', cleanupErrors)
}

export async function emptyObjectLockBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  await retryCleanupPhase('cancel unfinished large files', bucket, cleanupErrors, () =>
    cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors),
  )

  const deleted = new Set<string>()
  await retryCleanupPhase('delete Object Lock file versions', bucket, cleanupErrors, async () => {
    for await (const file of bucket.paginateFileVersions()) {
      await clearLegalHoldForDelete(bucket, file.fileName, file.fileId, cleanupErrors)
      const complianceRetainUntilTimestamp = complianceRetainUntilTimestampForCleanup(file)
      if (complianceRetainUntilTimestamp !== null) {
        await deleteComplianceRetainedFileVersionForCleanup(
          bucket,
          file.fileName,
          file.fileId,
          complianceRetainUntilTimestamp,
          deleted,
          cleanupErrors,
        )
        continue
      }
      await clearRetentionForDelete(bucket, file.fileName, file.fileId, cleanupErrors)
      await deleteFileVersionForCleanup(
        bucket,
        file.fileName,
        file.fileId,
        deleted,
        cleanupErrors,
        {
          bypassGovernance: true,
        },
      )
    }
  })

  throwCleanupErrors('empty Object Lock bucket', cleanupErrors)
}

export async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  try {
    await emptyBucket(bucket)
  } catch (err) {
    cleanupErrors.push(err)
  }

  if (await deleteBucketForCleanup(bucket, cleanupErrors)) return
  throwCleanupErrors('delete bucket', cleanupErrors)
}

export async function deleteObjectLockBucketIfPresent(bucket: Bucket): Promise<void> {
  const cleanupErrors: unknown[] = []
  try {
    await emptyObjectLockBucket(bucket)
  } catch (err) {
    cleanupErrors.push(err)
  }

  if (await deleteBucketForCleanup(bucket, cleanupErrors)) return
  throwCleanupErrors('delete Object Lock bucket', cleanupErrors)
}

export async function cancelUnfinishedLargeFiles(
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
  cleanupErrors: unknown[],
): Promise<void> {
  const cleared = await retryCleanupStep('clear legal hold', bucket, fileName, fileId, () =>
    bucket.updateFileLegalHold(fileName, fileId, LegalHoldValue.Off),
  )
  if (!cleared.ok) cleanupErrors.push(cleared.err)
}

async function clearRetentionForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
  cleanupErrors: unknown[],
): Promise<void> {
  const cleared = await retryCleanupStep('clear retention', bucket, fileName, fileId, () =>
    bucket.updateFileRetention(
      fileName,
      fileId,
      { mode: null, retainUntilTimestamp: null },
      { bypassGovernance: true },
    ),
  )
  if (!cleared.ok) cleanupErrors.push(cleared.err)
}

function complianceRetainUntilTimestampForCleanup(file: unknown): number | null {
  const retention = (
    file as {
      readonly fileRetention?: {
        readonly value?: FileRetentionValue | null
      }
    }
  ).fileRetention?.value
  if (retention?.mode !== RetentionMode.Compliance) return null
  return retention.retainUntilTimestamp
}

async function deleteComplianceRetainedFileVersionForCleanup(
  bucket: Bucket,
  fileName: string,
  fileId: Parameters<Bucket['deleteFileVersion']>[1],
  retainUntilTimestamp: number | null,
  deleted: Set<string>,
  cleanupErrors: unknown[],
): Promise<void> {
  if (retainUntilTimestamp === null) {
    cleanupErrors.push(
      new Error(
        `delete compliance file version failed bucket=${bucket.id} bucketName=${bucket.name} fileName=${fileName} fileId=${fileId}: missing retainUntilTimestamp`,
      ),
    )
    return
  }

  const waitMs = Math.max(0, retainUntilTimestamp - Date.now() + complianceCleanupClockSkewMs)
  if (waitMs > complianceCleanupMaxWaitMs) {
    cleanupErrors.push(
      new Error(
        `delete compliance file version would wait ${waitMs}ms bucket=${bucket.id} bucketName=${bucket.name} fileName=${fileName} fileId=${fileId} retainUntilTimestamp=${retainUntilTimestamp} now=${Date.now()}`,
      ),
    )
    return
  }
  if (waitMs > 0) await delay(waitMs)

  const deadline = Date.now() + complianceCleanupRetryBudgetMs
  for (;;) {
    try {
      await deleteFileVersionOnce(bucket, fileName, fileId, deleted)
      return
    } catch (err) {
      const now = Date.now()
      if (!hasB2ErrorCode(err, complianceProtectedErrorCode) || now >= deadline) {
        cleanupErrors.push(
          new Error(
            `delete compliance file version failed bucket=${bucket.id} bucketName=${bucket.name} fileName=${fileName} fileId=${fileId} retainUntilTimestamp=${retainUntilTimestamp} now=${now} error=${safeErrorSummary(err)}`,
          ),
        )
        return
      }
      logCleanupFailure(
        `delete compliance file version still protected retainUntilTimestamp=${retainUntilTimestamp} now=${now}`,
        bucket,
        fileName,
        fileId,
        err,
      )
      await delay(complianceCleanupRetryDelayMs)
    }
  }
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

async function deleteBucketForCleanup(bucket: Bucket, cleanupErrors: unknown[]): Promise<boolean> {
  let lastError: unknown
  for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
    try {
      await bucket.delete()
      return true
    } catch (err) {
      if (err instanceof BadBucketIdError) return true
      lastError = err
      logCleanupPhaseFailure(`delete bucket attempt=${attempt}/${cleanupAttempts}`, bucket, err)
      if (attempt < cleanupAttempts) await delay(cleanupRetryDelayMs)
    }
  }
  cleanupErrors.push(lastError)
  return false
}

async function retryCleanupPhase(
  action: string,
  bucket: Bucket,
  cleanupErrors: unknown[],
  fn: () => Promise<unknown>,
): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
    try {
      await fn()
      return
    } catch (err) {
      lastError = err
      logCleanupPhaseFailure(`${action} attempt=${attempt}/${cleanupAttempts}`, bucket, err)
      if (attempt < cleanupAttempts) await delay(cleanupRetryDelayMs)
    }
  }
  cleanupErrors.push(lastError)
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

function logCleanupPhaseFailure(action: string, bucket: Bucket, err: unknown): void {
  console.warn(
    `[b2 integration cleanup] ${action} failed bucket=${bucket.id} bucketName=${bucket.name} error=${safeErrorSummary(err)}`,
  )
}

function logCleanupFailure(
  action: string,
  bucket: Bucket,
  fileName: string,
  fileId: string,
  err: unknown,
): void {
  console.warn(
    `[b2 integration cleanup] ${action} failed bucket=${bucket.id} bucketName=${bucket.name} fileName=${fileName} fileId=${fileId} error=${safeErrorSummary(err)}`,
  )
}

export function makeBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < bytes.byteLength; i++) {
    bytes[i] = (seed + i * 31) & 0xff
  }
  return bytes
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const combined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    combined.set(part, offset)
    offset += part.byteLength
  }
  return combined
}

export async function readAllBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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
  return concatBytes(chunks)
}

export async function readRequiredBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array> {
  expect(body).not.toBeNull()
  if (body === null) throw new Error('Expected B2 download response body')
  return readAllBytes(body)
}

export function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  for (let i = 0; i < actual.byteLength; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`Byte mismatch at offset ${i}: expected ${expected[i]}, got ${actual[i]}`)
    }
  }
}

export function safeErrorSummary(err: unknown): string {
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

export function logSetup(message: string): void {
  console.info(`[b2 integration setup] ${message}`)
}

export function logFeatureSkip(feature: string, reason: string): void {
  console.warn(`[b2 integration] ${feature}: skipped (${reason})`)
}

export function requireFeatureCapabilities(
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): void {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return
  throw new Error(`${feature} requires B2 capabilities: ${check.missing.join(', ')}`)
}

export function skipIfMissingFeatureCapabilities(
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

export function isObjectLockUnavailableError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'unauthorized') ||
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'file_lock_not_enabled')
  )
}

export async function withRecommendedPartSize<T>(
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

export async function setupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
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

export async function sweepStaleIntegrationBuckets(existing: readonly Bucket[]): Promise<void> {
  const now = Date.now()
  const staleBuckets = existing.filter((bucket) => isStaleIntegrationBucket(bucket.name, now))
  let deletedCount = 0
  let skippedCount = 0

  logSetup(`stale bucket sweep: ${staleBuckets.length} candidate(s) among ${existing.length}`)

  for (const bucket of staleBuckets) {
    const start = performance.now()
    try {
      if (isFileLockEnabledBucket(bucket)) {
        await deleteObjectLockBucketIfPresent(bucket)
      } else {
        await deleteBucketIfPresent(bucket)
      }
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

function isFileLockEnabledBucket(bucket: Bucket): boolean {
  const info = (bucket as { readonly info?: Bucket['info'] }).info
  return info?.fileLockConfiguration?.value?.isFileLockEnabled === true
}

export async function uploadRawPart(
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

export async function fetchBytesWithDeadline(
  url: string,
  timeoutMs = directFetchTimeoutMs,
): Promise<{ readonly status: number; readonly bytes: Uint8Array }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(`fetch timed out after ${timeoutMs}ms`, 'TimeoutError'))
  }, timeoutMs)
  let response: Response | undefined

  try {
    response = await fetch(url, { signal: controller.signal })
    return {
      status: response.status,
      bytes: new Uint8Array(await response.arrayBuffer()),
    }
  } finally {
    clearTimeout(timeout)
    if (response !== undefined && !response.bodyUsed) {
      await response.body?.cancel().catch(() => {})
    }
  }
}
