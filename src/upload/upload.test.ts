import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import type { B2Client } from '../client.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'
import { uploadLargeFile } from './large.ts'
import { uploadSmallFile } from './single.ts'

// The simulator's absoluteMinimumPartSize is 5_000_000. uploadLargeFile
// clamps partSize to >= minPartSize, so any test in this file uses small
// payloads that fit in a single part. Real multipart round-trips live in
// `upload.slow.test.ts` to keep `pnpm test` under a minute.

describe('uploadLargeFile (single-part, data < minPartSize)', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'plan-parts',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('uploads small data as a single part when partSize is clamped', async () => {
    const data = deterministicBytes(400)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'small-clamped.bin',
      source: new BufferSource(data),
      partSize: 100,
    })

    expect(result.fileName).toBe('small-clamped.bin')
    expect(result.contentLength).toBe(400)
  })

  it('uploads when partSize >= totalSize (single part)', async () => {
    const data = deterministicBytes(50)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'single-part.bin',
      source: new BufferSource(data),
      partSize: 10_000_000,
    })

    expect(result.fileName).toBe('single-part.bin')
    expect(result.contentLength).toBe(50)
  })

  it('sets content type on the large file', async () => {
    const data = deterministicBytes(500)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'typed.json',
      source: new BufferSource(data),
      partSize: 5_000_000,
      contentType: 'application/json',
    })

    expect(result.contentType).toBe('application/json')
  })

  it('defaults content type to b2/x-auto', async () => {
    const data = deterministicBytes(500)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'auto-type.bin',
      source: new BufferSource(data),
    })

    expect(result.contentType).toBe('b2/x-auto')
  })

  it('multiple uploads coexist in the same bucket', async () => {
    const data1 = deterministicBytes(1000)
    const data2 = deterministicBytes(2000)

    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'alpha.bin',
      source: new BufferSource(data1),
    })
    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'beta.bin',
      source: new BufferSource(data2),
    })

    const listing = await bucket.listFileNames()
    const names = listing.files.map((f) => f.fileName).sort()
    expect(names).toEqual(['alpha.bin', 'beta.bin'])

    const dl1 = await bucket.download('alpha.bin')
    expect((await readStream(dl1.body)).byteLength).toBe(1000)

    const dl2 = await bucket.download('beta.bin')
    expect((await readStream(dl2.body)).byteLength).toBe(2000)
  })
})

describe('uploadLargeFile cancellation', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'cancel', bucketType: BucketType.AllPrivate })
  })

  it('cancels when signal is already aborted', async () => {
    const data = deterministicBytes(500)
    const controller = new AbortController()
    controller.abort()

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'aborted.bin',
        source: new BufferSource(data),
        signal: controller.signal,
      }),
    ).rejects.toThrow()

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files).toHaveLength(0)
  })
})

describe('uploadSmallFile edge cases', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'small-upload',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('uploads an empty file (zero bytes)', async () => {
    const data = new Uint8Array(0)
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'empty.txt',
      source: new BufferSource(data),
      contentType: 'text/plain',
    })

    expect(result.fileName).toBe('empty.txt')
    expect(result.contentLength).toBe(0)
    expect(result.contentType).toBe('text/plain')

    const dl = await bucket.download('empty.txt')
    expect((await readStream(dl.body)).byteLength).toBe(0)
  })

  it('uploads with custom file info metadata', async () => {
    const data = new TextEncoder().encode('metadata test')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'with-meta.txt',
      source: new BufferSource(data),
      fileInfo: { src_last_modified_millis: '1700000000000' },
    })

    expect(result.fileName).toBe('with-meta.txt')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('defaults content type to b2/x-auto', async () => {
    const data = new TextEncoder().encode('auto-detect me')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'auto.bin',
      source: new BufferSource(data),
    })

    expect(result.contentType).toBe('b2/x-auto')
  })

  it('preserves binary content after round-trip', async () => {
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i

    await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'binary.bin',
      source: new BufferSource(data),
    })

    const dl = await bucket.download('binary.bin')
    expect(await readStream(dl.body)).toEqual(data)
  })

  it('uploads a 1-byte file', async () => {
    const data = new Uint8Array([42])
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'one-byte.bin',
      source: new BufferSource(data),
    })

    expect(result.contentLength).toBe(1)
  })

  it('handles file names with path separators', async () => {
    const data = new TextEncoder().encode('nested content')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'path/to/nested/file.txt',
      source: new BufferSource(data),
    })

    expect(result.fileName).toBe('path/to/nested/file.txt')
  })

  it('passes lastModifiedMillis through to upload', async () => {
    const data = new TextEncoder().encode('timestamped')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'dated.txt',
      source: new BufferSource(data),
      lastModifiedMillis: 1700000000000,
    })

    expect(result.fileName).toBe('dated.txt')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('passes serverSideEncryption through to upload', async () => {
    const data = new TextEncoder().encode('encrypted')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'sse.txt',
      source: new BufferSource(data),
      serverSideEncryption: { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 },
    })

    expect(result.fileName).toBe('sse.txt')
  })

  it('passes fileRetention and legalHold through to upload', async () => {
    const data = new TextEncoder().encode('locked')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'locked.txt',
      source: new BufferSource(data),
      fileRetention: {
        mode: RetentionMode.Compliance,
        retainUntilTimestamp: Date.now() + 86400000,
      },
      legalHold: LegalHoldValue.On,
    })

    expect(result.fileName).toBe('locked.txt')
  })

  it('reuses upload URLs across multiple uploads', async () => {
    const r1 = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'first.txt',
      source: new BufferSource(new TextEncoder().encode('first')),
    })
    const r2 = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'second.txt',
      source: new BufferSource(new TextEncoder().encode('second')),
    })

    expect(r1.fileName).toBe('first.txt')
    expect(r2.fileName).toBe('second.txt')
  })
})

describe('Bucket.upload() routing', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'routing', bucketType: BucketType.AllPrivate })
  })

  it('routes to small file upload when below recommended part size', async () => {
    const data = new TextEncoder().encode('small file content')
    const result = await bucket.upload({
      fileName: 'small.txt',
      source: new BufferSource(data),
      contentType: 'text/plain',
    })

    expect(result.fileName).toBe('small.txt')
    expect(result.action).toBe('upload')
  })

  it('partSize option does not change routing decision', async () => {
    const data = new TextEncoder().encode('still small')
    const result = await bucket.upload({
      fileName: 'still-small.txt',
      source: new BufferSource(data),
      partSize: 5,
    })

    expect(result.fileName).toBe('still-small.txt')
  })

  it('routes to large file upload when source exceeds recommended part size', async () => {
    vi.spyOn(client.accountInfo, 'getRecommendedPartSize').mockReturnValue(10)

    const data = deterministicBytes(50)
    const result = await bucket.upload({
      fileName: 'force-large.bin',
      source: new BufferSource(data),
    })

    expect(result.fileName).toBe('force-large.bin')
    expect(result.contentLength).toBe(50)

    vi.restoreAllMocks()
  })

  it('routes EXACT-size match (size === recommendedPartSize) through the small-file path', async () => {
    // Boundary: `Bucket.upload`'s dispatch is `isLarge = size >
    // recommendedPartSize` (strict greater-than). At exact equality
    // the small-file path is chosen — a single `b2_upload_file` call,
    // not a multipart upload. Validate by inspecting the resulting
    // file's `contentSha1`: small-file uploads have a real per-file
    // SHA-1; multipart-finished files have the wire sentinel `'none'`
    // (which the raw-client normalisation collapses to `null`).
    // A null contentSha1 here would mean we accidentally took the
    // multipart path at the boundary.
    const { client: boundaryClient } = makeClient({
      minimumPartSize: 100,
      recommendedPartSize: 100,
    })
    await boundaryClient.authorize()
    const boundaryBucket = await boundaryClient.createBucket({
      bucketName: 'partsize-boundary',
      bucketType: BucketType.AllPrivate,
    })

    const data = deterministicBytes(100) // exactly recommendedPartSize
    const result = await boundaryBucket.upload({
      fileName: 'exactly-part-size.bin',
      source: new BufferSource(data),
    })

    expect(result.contentLength).toBe(100)
    // Small-file path: real SHA-1, not the multipart null sentinel.
    expect(result.contentSha1).not.toBeNull()
    expect(result.contentSha1).toMatch(/^[0-9a-f]{40}$/)
  })
})
