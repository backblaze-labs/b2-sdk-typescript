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
import { BufferSource } from '../../src/streams/source.ts'
import { deleteFileVersionOnce } from '../helpers/b2-cleanup.ts'

const keyId = process.env.B2_APPLICATION_KEY_ID ?? ''
const appKey = process.env.B2_APPLICATION_KEY ?? ''
const requireCredentials = process.env.B2_INTEGRATION_REQUIRE_CREDENTIALS === '1'

const skip = !keyId || !appKey
const currentBucketPrefix = 'sdk-it-'
const legacyBucketPrefix = 'sdk-test-'
const staleBucketAgeMs = 60 * 60 * 1000

if (skip && requireCredentials) {
  throw new Error(
    'B2 integration credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1',
  )
}

function makeBucketName(): string {
  const runId = process.env.GITHUB_RUN_ID
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  const now = Date.now()
  if (runId !== undefined && runId !== '') {
    return `${currentBucketPrefix}${runId}-${runAttempt}-${now}`
  }
  return `${currentBucketPrefix}${now}`
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

async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyBucket(bucket)
    await bucket.delete()
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

function setupErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function logSetup(message: string): void {
  console.info(`[b2 integration setup] ${message}`)
}

async function setupStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  logSetup(`${name}: start`)
  try {
    const result = await fn()
    logSetup(`${name}: ok (${Math.round(performance.now() - start)}ms)`)
    return result
  } catch (err) {
    logSetup(`${name}: failed after ${Math.round(performance.now() - start)}ms`)
    console.error(`[b2 integration setup] ${name}: ${setupErrorMessage(err)}`)
    throw err
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
    const reader = result.body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const combined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      combined.set(c, offset)
      offset += c.byteLength
    }

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
