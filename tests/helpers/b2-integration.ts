import type { TestContext } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import type { B2Client } from '../../src/client.ts'
import { BadBucketIdError } from '../../src/errors/index.ts'
import type { Capability as CapabilityValue } from '../../src/types/auth.ts'
import type { FileId } from '../../src/types/ids.ts'
import { LegalHoldValue } from '../../src/types/lock.ts'
import { deleteFileVersionOnce, hasB2ErrorCode } from './b2-cleanup.ts'

export const integrationBucketPrefix = 'sdk-it-'
export const objectLockBucketPrefix = 'sdk-it-lock-'
export const legacyBucketPrefix = 'sdk-test-'
export const maxBucketNameLength = 50
export const staleBucketAgeMs = 60 * 60 * 1000

const maxRunIdSegmentLength = 8
const maxRunAttemptSegmentLength = 2
const setupStepTimeoutMs = 60 * 1000
const cleanupAttempts = 3
const cleanupRetryDelayMs = 250
const retentionExpirySkewMs = 3_000
const maxRetentionWaitMs = 30_000

interface CleanupFailureContext {
  readonly action: string
  readonly bucket: Bucket
  readonly fileName: string
  readonly fileId: string
  readonly err: unknown
}

function compactBucketNameSegment(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return fallback
  const compact = /^\d+$/.test(trimmed) ? BigInt(trimmed).toString(36) : trimmed
  const safe = compact.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return (safe === '' ? fallback : safe).slice(-maxLength)
}

function bucketNameLabelSegment(label: string | undefined, maxLength: number): string | undefined {
  if (label === undefined || maxLength < 1) return undefined
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/[-.]+$/g, '')
  return safe === '' ? undefined : safe
}

export function makeBucketName(label?: string, options: { objectLock?: boolean } = {}): string {
  const runId = process.env['GITHUB_RUN_ID']
  const runAttempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1'
  const timestamp = `${Date.now()}`
  const prefix = options.objectLock === true ? objectLockBucketPrefix : integrationBucketPrefix
  const runSegment = compactBucketNameSegment(runId, 'local', maxRunIdSegmentLength)
  const attemptSegment = compactBucketNameSegment(runAttempt, '1', maxRunAttemptSegmentLength)
  const fixedLength =
    prefix.length + runSegment.length + 1 + attemptSegment.length + 1 + timestamp.length
  const labelSegment = bucketNameLabelSegment(label, maxBucketNameLength - fixedLength - 1)
  const segments =
    labelSegment === undefined
      ? [runSegment, attemptSegment, timestamp]
      : [runSegment, attemptSegment, labelSegment, timestamp]
  return `${prefix}${segments.join('-')}`
}

export function isObjectLockIntegrationBucketName(name: string): boolean {
  return name.startsWith(objectLockBucketPrefix) || isLegacyObjectLockIntegrationBucketName(name)
}

function isLegacyObjectLockIntegrationBucketName(name: string): boolean {
  if (!name.startsWith(integrationBucketPrefix)) return false
  const suffix = name.slice(integrationBucketPrefix.length)
  return /^\d+-\d+-lock-\d{13}$/.test(suffix)
}

function isIntegrationBucketName(name: string): boolean {
  return (
    name.startsWith(integrationBucketPrefix) ||
    name.startsWith(objectLockBucketPrefix) ||
    name.startsWith(legacyBucketPrefix)
  )
}

function bucketTimestamp(name: string): number | null {
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

export function logFeatureSkip(feature: string, reason: string): void {
  console.warn(`[b2 integration] ${feature}: skipped (${reason})`)
}

export function requireFeatureCapabilities(
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): void {
  const reason = missingFeatureCapabilitiesReason(client, feature, capabilities)
  if (reason === null) return
  throw new Error(reason)
}

export function skipIfMissingFeatureCapabilities(
  ctx: TestContext,
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): boolean {
  const reason = missingFeatureCapabilitiesReason(client, feature, capabilities)
  if (reason === null) return false
  logFeatureSkip(feature, reason)
  ctx.skip(reason)
  return true
}

export function missingFeatureCapabilitiesReason(
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): string | null {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return null
  return `${feature} requires B2 capabilities: ${check.missing.join(', ')}`
}

export function isObjectLockUnavailableError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'unauthorized') ||
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'file_lock_not_enabled')
  )
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
      if (isObjectLockIntegrationBucketName(bucket.name)) {
        await deleteObjectLockBucketIfPresent(bucket)
      } else {
        await deleteBucketIfPresent(bucket)
      }
      deletedCount += 1
      logSetup(
        `delete stale bucket ${bucket.name} (${bucket.id}): ok (${Math.round(
          performance.now() - start,
        )}ms)`,
      )
    } catch (err) {
      skippedCount += 1
      console.warn(
        `[b2 integration setup] delete stale bucket ${bucket.name} (${bucket.id}): skipped after ${Math.round(
          performance.now() - start,
        )}ms (${safeErrorSummary(err)})`,
      )
    }
  }

  logSetup(`stale bucket sweep: deleted ${deletedCount}, skipped ${skippedCount}`)
}

export async function emptyBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: Error[] = []
  await cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors)

  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileNames()) {
    await deleteFileVersionForCleanup(bucket, file.fileName, file.fileId, deleted, cleanupErrors)
  }

  const versions = await bucket.listFileVersions()
  for (const file of versions.files) {
    await deleteFileVersionForCleanup(bucket, file.fileName, file.fileId, deleted, cleanupErrors)
  }

  throwCleanupErrors('empty bucket', cleanupErrors)
}

export async function emptyObjectLockBucket(bucket: Bucket): Promise<void> {
  const cleanupErrors: Error[] = []
  await cancelUnfinishedLargeFiles(bucket, undefined, cleanupErrors)

  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileVersions()) {
    await cleanupObjectLockFileVersion(bucket, file.fileName, file.fileId, deleted, cleanupErrors)
  }

  throwCleanupErrors('empty Object Lock bucket', cleanupErrors)
}

export async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

export async function deleteObjectLockBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyObjectLockBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

export async function cancelUnfinishedLargeFiles(
  bucket: Bucket,
  namePrefix?: string,
  cleanupErrors: Error[] = [],
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
    if (!cancelled.ok) {
      cleanupErrors.push(
        cleanupFailure({
          action: 'cancel unfinished large file',
          bucket,
          fileName: file.fileName,
          fileId: file.fileId,
          err: cancelled.err,
        }),
      )
    }
  }
}

function logSetup(message: string): void {
  console.info(`[b2 integration setup] ${message}`)
}

async function cleanupObjectLockFileVersion(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
  deleted: Set<string>,
  cleanupErrors: Error[],
): Promise<void> {
  const hold = await clearLegalHoldForDelete(bucket, fileName, fileId)
  if (!hold.ok) {
    cleanupErrors.push(
      cleanupFailure({ action: 'clear legal hold', bucket, fileName, fileId, err: hold.err }),
    )
  }

  const retention = await clearRetentionForDelete(bucket, fileName, fileId)
  if (!retention.ok) {
    cleanupErrors.push(
      cleanupFailure({ action: 'clear retention', bucket, fileName, fileId, err: retention.err }),
    )
  }

  const deletedVersion = await retryCleanupStep(
    'delete file version',
    bucket,
    fileName,
    fileId,
    () => deleteFileVersionOnce(bucket, fileName, fileId, deleted, { bypassGovernance: true }),
  )
  if (!deletedVersion.ok) {
    cleanupErrors.push(
      cleanupFailure({
        action: 'delete file version',
        bucket,
        fileName,
        fileId,
        err: deletedVersion.err,
      }),
    )
  }
}

async function clearLegalHoldForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  return retryCleanupStep('clear legal hold', bucket, fileName, fileId, async () => {
    try {
      await bucket.updateFileLegalHold(fileName, fileId, LegalHoldValue.Off)
    } catch (err) {
      if (!hasB2ErrorCode(err, 'file_not_present') && !hasB2ErrorCode(err, 'no_such_file')) {
        throw err
      }
    }
  })
}

async function clearRetentionForDelete(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
): Promise<{ ok: true } | { ok: false; err: unknown }> {
  return retryCleanupStep('clear retention', bucket, fileName, fileId, async () => {
    try {
      await clearRetention(bucket, fileName, fileId)
    } catch (err) {
      if (!hasB2ErrorCode(err, 'file_lock_compliance_protected')) throw err
      const info = await bucket.file(fileName).getFileInfo(fileId)
      await waitUntilRetentionExpires(info.fileRetention.value?.retainUntilTimestamp ?? null)
      await clearRetention(bucket, fileName, fileId)
    }
  })
}

async function clearRetention(bucket: Bucket, fileName: string, fileId: FileId): Promise<void> {
  await bucket.updateFileRetention(
    fileName,
    fileId,
    { mode: null, retainUntilTimestamp: null },
    { bypassGovernance: true },
  )
}

async function deleteFileVersionForCleanup(
  bucket: Bucket,
  fileName: string,
  fileId: FileId,
  deleted: Set<string>,
  cleanupErrors: Error[],
  options?: Parameters<Bucket['deleteFileVersion']>[2],
): Promise<void> {
  const deletedVersion = await retryCleanupStep(
    'delete file version',
    bucket,
    fileName,
    fileId,
    () => deleteFileVersionOnce(bucket, fileName, fileId, deleted, options),
  )
  if (!deletedVersion.ok) {
    cleanupErrors.push(
      cleanupFailure({
        action: 'delete file version',
        bucket,
        fileName,
        fileId,
        err: deletedVersion.err,
      }),
    )
  }
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

async function waitUntilRetentionExpires(retainUntilTimestamp: number | null): Promise<void> {
  if (retainUntilTimestamp === null) return
  const waitMs = retainUntilTimestamp - Date.now() + retentionExpirySkewMs
  if (waitMs <= 0) return
  if (waitMs > maxRetentionWaitMs) {
    throw new Error(
      `retention expires too far in the future for cleanup: retainUntilTimestamp=${retainUntilTimestamp} waitMs=${waitMs}`,
    )
  }
  await delay(waitMs)
}

function throwCleanupErrors(action: string, errors: readonly Error[]): void {
  if (errors.length === 0) return
  throw new AggregateError(errors, `${action} failed for ${errors.length} cleanup operation(s)`)
}

function cleanupFailure(context: CleanupFailureContext): Error {
  return new Error(
    `${context.action} failed bucket=${context.bucket.id} bucketName=${context.bucket.name} fileName=${context.fileName} fileId=${context.fileId} error=${safeErrorSummary(context.err)}`,
    { cause: context.err },
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
