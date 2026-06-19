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

const keyId = process.env.B2_APPLICATION_KEY_ID ?? ''
const appKey = process.env.B2_APPLICATION_KEY ?? ''

const skip = !keyId || !appKey
const currentBucketPrefix = 'sdk-it-'
const legacyBucketPrefix = 'sdk-test-'
const staleBucketAgeMs = 60 * 60 * 1000

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
  for await (const file of bucket.paginateFileNames()) {
    await bucket.deleteFileVersion(file.fileName, file.fileId)
  }

  const versions = await bucket.listFileVersions()
  for (const fv of versions.files) {
    await bucket.deleteFileVersion(fv.fileName, fv.fileId)
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

describe.skipIf(skip)('B2 integration', () => {
  let client: B2Client
  let bucket: Bucket
  const bucketName = makeBucketName()

  beforeAll(async () => {
    client = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await client.authorize()

    // Defensive: sweep stale integration buckets from prior runs that crashed
    // before their afterAll cleanup. Keep this age-gated so another branch's
    // live integration run cannot have its bucket removed mid-test.
    const existing = await client.listBuckets()
    const now = Date.now()
    for (const b of existing) {
      if (!isStaleIntegrationBucket(b.name, now)) continue
      try {
        await deleteBucketIfPresent(b)
      } catch {
        // Skip buckets we can't clean up (permissions, in-flight uploads).
        // They'll surface as a hard bucket-limit error later, which is the
        // right place to fix it.
      }
    }

    bucket = await client.createBucket({
      bucketName,
      bucketType: 'allPrivate',
    })
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
