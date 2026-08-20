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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { BadBucketIdError } from '../../src/errors/index.ts'
import { IncrementalSha1 } from '../../src/streams/hash.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { Capability, type Capability as CapabilityValue } from '../../src/types/auth.ts'
import { SSE_B2 } from '../../src/types/encryption.ts'
import type { LargeFileId } from '../../src/types/ids.ts'
import { LegalHoldValue, RetentionMode } from '../../src/types/lock.ts'
import { uploadLargeFile } from '../../src/upload/large.ts'
import { deleteFileVersionOnce, hasB2ErrorCode } from '../helpers/b2-cleanup.ts'

const keyId = process.env.B2_APPLICATION_KEY_ID ?? ''
const appKey = process.env.B2_APPLICATION_KEY ?? ''
const requireCredentials = process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS === '1'

const skip = !keyId || !appKey
const currentBucketPrefix = 'sdk-it-'
const legacyBucketPrefix = 'sdk-test-'
const staleBucketAgeMs = 60 * 60 * 1000
const setupStepTimeoutMs = 60 * 1000

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
  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileNames()) {
    await deleteFileVersionOnce(bucket, file.fileName, file.fileId, deleted)
  }

  const versions = await bucket.listFileVersions()
  for (const fv of versions.files) {
    await deleteFileVersionOnce(bucket, fv.fileName, fv.fileId, deleted)
  }
}

async function emptyObjectLockBucket(bucket: Bucket): Promise<void> {
  const deleted = new Set<string>()
  for await (const file of bucket.paginateFileVersions()) {
    await bucket.updateFileLegalHold(file.fileName, file.fileId, LegalHoldValue.Off).catch(() => {})
    await bucket
      .updateFileRetention(
        file.fileName,
        file.fileId,
        { mode: null, retainUntilTimestamp: null },
        { bypassGovernance: true },
      )
      .catch(() => {})

    const key = `${file.fileName}\0${file.fileId}`
    if (deleted.has(key)) continue
    deleted.add(key)
    try {
      await bucket.deleteFileVersion(file.fileName, file.fileId, { bypassGovernance: true })
    } catch (err) {
      if (!hasB2ErrorCode(err, 'file_not_present') && !hasB2ErrorCode(err, 'no_such_file')) {
        throw err
      }
    }
  }
}

async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    await deleteObjectLockBucketIfPresent(bucket)
    return
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

async function sha1Hex(data: Uint8Array): Promise<string> {
  const sha1 = new IncrementalSha1()
  await sha1.update(data)
  return await sha1.digest()
}

async function uploadRawPart(
  client: B2Client,
  fileId: LargeFileId,
  partNumber: number,
  data: Uint8Array,
): Promise<string> {
  const uploadUrl = await client.raw.getUploadPartUrl(
    client.accountInfo.getApiUrl(),
    client.accountInfo.getAuthToken(),
    { fileId },
  )
  const contentSha1 = await sha1Hex(data)
  const part = await client.raw.uploadPart(
    uploadUrl.uploadUrl,
    {
      authorization: uploadUrl.authorizationToken,
      partNumber,
      contentLength: data.byteLength,
      contentSha1,
    },
    data,
  )
  expect(part.contentSha1).toBe(contentSha1)
  return part.contentSha1
}

function setupErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function logSetup(message: string): void {
  console.info(`[b2 integration setup] ${message}`)
}

function logFeatureSkip(feature: string, reason: string): void {
  console.warn(`[b2 integration] ${feature}: skipped (${reason})`)
}

function hasFeatureCapabilities(
  client: B2Client,
  feature: string,
  capabilities: readonly CapabilityValue[],
): boolean {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return true
  logFeatureSkip(feature, `missing capabilities: ${check.missing.join(', ')}`)
  return false
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
    console.error(`[b2 integration setup] ${name}: ${setupErrorMessage(err)}`)
    throw err
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (timedOut) {
      void operation.catch((err) => {
        console.warn(
          `[b2 integration setup] ${name}: underlying operation rejected after timeout (${setupErrorMessage(err)})`,
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
        )}ms (${setupErrorMessage(err)})`,
      )
    }
  }

  logSetup(`stale bucket sweep: deleted ${deletedCount}, skipped ${skippedCount}`)
}

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

    const file = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName,
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 2,
    })

    expect(file.fileName).toBe(fileName)
    expect(file.action).toBe('upload')
    expect(file.contentLength).toBe(data.byteLength)

    const downloaded = await bucket.download(fileName)
    expectBytesEqual(await readAllBytes(downloaded.body), data)
  })

  it('resumes an explicit unfinished multipart upload and finishes it', async () => {
    const feature = 'explicit multipart resume'
    if (
      !hasFeatureCapabilities(client, feature, [
        Capability.ListFiles,
        Capability.ReadFiles,
        Capability.WriteFiles,
        Capability.ReadFileLegalHolds,
        Capability.ReadFileRetentions,
      ])
    ) {
      return
    }

    const partSize = client.accountInfo.getAbsoluteMinimumPartSize()
    const data = makeBytes(partSize + 2048, 29)
    const fileName = 'large-resume.bin'
    const started = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName,
        contentType: 'application/octet-stream',
        fileInfo: {},
      },
    )
    let finished = false

    try {
      const firstPartSha1 = await uploadRawPart(
        client,
        started.fileId,
        1,
        data.subarray(0, partSize),
      )
      const reusedParts: number[] = []

      const file = await uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName,
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        concurrency: 2,
        resumeFileId: started.fileId,
        onResumePartReused: (event) => reusedParts.push(event.partNumber),
      })
      finished = true

      expect(file.fileId).toBe(started.fileId)
      expect(file.contentLength).toBe(data.byteLength)
      expect(reusedParts).toEqual([1])
      expect(firstPartSha1).toHaveLength(40)

      const downloaded = await bucket.download(fileName)
      expectBytesEqual(await readAllBytes(downloaded.body), data)
    } finally {
      if (!finished) {
        await client.raw
          .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
            fileId: started.fileId,
          })
          .catch(() => {})
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

    await writer.write(data.subarray(0, Math.floor(partSize / 2)))
    await writer.write(data.subarray(Math.floor(partSize / 2), partSize + 111))
    await writer.write(data.subarray(partSize + 111))
    await writer.close()
    const file = await done

    expect(file.fileName).toBe(fileName)
    expect(file.contentLength).toBe(data.byteLength)

    const stream = bucket.file(fileName).createReadStream(file.fileId, file.contentLength, {
      rangeSize: Math.floor(partSize / 3),
      concurrency: 2,
    })
    expectBytesEqual(await readAllBytes(stream), data)
  })

  it('uploads and reads an SSE-B2 encrypted file when supported', async () => {
    const feature = 'SSE-B2 upload/download'
    if (!hasFeatureCapabilities(client, feature, [Capability.WriteFiles, Capability.ReadFiles])) {
      return
    }

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

  it('updates file retention and legal hold in a file-lock bucket when permitted', async () => {
    const feature = 'Object Lock retention/legal hold'
    if (
      !hasFeatureCapabilities(client, feature, [
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
    ) {
      return
    }

    let lockBucket: Bucket
    try {
      lockBucket = await client.createBucket({
        bucketName: makeBucketName('lock'),
        bucketType: 'allPrivate',
        fileLockEnabled: true,
      })
    } catch (err) {
      logFeatureSkip(feature, `file-lock bucket unavailable: ${setupErrorMessage(err)}`)
      return
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
      expect(retained.fileRetention).toEqual({
        mode: RetentionMode.Governance,
        retainUntilTimestamp,
      })

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

    await expect(
      client.raw.uploadFile(
        uploadUrl.uploadUrl,
        {
          authorization: `${uploadUrl.authorizationToken}-stale`,
          fileName: 'invalid-upload-token.txt',
          contentType: 'text/plain',
          contentLength: data.byteLength,
          contentSha1: await sha1Hex(data),
        },
        data,
      ),
    ).rejects.toThrow(/auth|401|unauthorized/i)
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
