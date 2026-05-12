import { beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.js'
import { B2Simulator } from '../simulator/index.js'
import { BufferSource } from '../streams/source.js'
import type { Bucket } from '../bucket.js'
import { uploadLargeFile } from './large.js'
import { uploadSmallFile } from './single.js'

function makeClient(): { client: B2Client; sim: B2Simulator } {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.byteLength
  }
  return result
}

function deterministicBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    buf[i] = i % 251
  }
  return buf
}

// The simulator's absoluteMinimumPartSize is 5_000_000.
// uploadLargeFile clamps partSize to >= minPartSize, so we can't force
// parts smaller than 5MB. Tests that need real multipart use 5MB+ buffers.
const LARGE_TEST_TIMEOUT = 60_000

describe('uploadLargeFile (single-part, data < minPartSize)', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'plan-parts', bucketType: 'allPrivate' })
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

describe('uploadLargeFile (real multipart, data > minPartSize)', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'multipart', bucketType: 'allPrivate' })
  })

  it(
    'creates two parts and round-trips data correctly',
    async () => {
      const size = 5_000_010
      const data = deterministicBytes(size)
      const result = await uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'two-parts.bin',
        source: new BufferSource(data),
        partSize: 5_000_000,
        concurrency: 1,
      })

      expect(result.contentLength).toBe(size)
      expect(result.fileName).toBe('two-parts.bin')

      const dl = await bucket.download('two-parts.bin')
      const downloaded = await readStream(dl.body)
      expect(downloaded).toEqual(data)
    },
    LARGE_TEST_TIMEOUT,
  )

  it(
    'reports progress events during multipart upload',
    async () => {
      const size = 5_000_010
      const data = deterministicBytes(size)
      const events: { bytesTransferred: number; partsCompleted: number }[] = []

      await uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'progress.bin',
        source: new BufferSource(data),
        partSize: 5_000_000,
        concurrency: 1,
        onProgress: (event) => {
          events.push({
            bytesTransferred: event.bytesTransferred,
            partsCompleted: event.partsCompleted,
          })
        },
      })

      // addBytes + completePart per part = at least 4 events for 2 parts
      expect(events.length).toBeGreaterThanOrEqual(4)

      const last = events[events.length - 1]!
      expect(last.bytesTransferred).toBe(size)
      expect(last.partsCompleted).toBe(2)
    },
    LARGE_TEST_TIMEOUT,
  )

  it(
    'appears in bucket listing after multipart upload',
    async () => {
      const data = deterministicBytes(5_000_010)
      await uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'listed.bin',
        source: new BufferSource(data),
        partSize: 5_000_000,
        concurrency: 1,
      })

      const listing = await bucket.listFileNames()
      expect(listing.files).toHaveLength(1)
      expect(listing.files[0]?.fileName).toBe('listed.bin')
      expect(listing.files[0]?.contentLength).toBe(5_000_010)
    },
    LARGE_TEST_TIMEOUT,
  )
})

describe('uploadLargeFile cancellation', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'cancel', bucketType: 'allPrivate' })
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
    bucket = await client.createBucket({ bucketName: 'small-upload', bucketType: 'allPrivate' })
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
      serverSideEncryption: { mode: 'SSE-B2' },
    })

    expect(result.fileName).toBe('sse.txt')
  })

  it('passes fileRetention and legalHold through to upload', async () => {
    const data = new TextEncoder().encode('locked')
    const result = await uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'locked.txt',
      source: new BufferSource(data),
      fileRetention: { mode: 'compliance', retainUntilTimestamp: Date.now() + 86400000 },
      legalHold: 'on',
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
    bucket = await client.createBucket({ bucketName: 'routing', bucketType: 'allPrivate' })
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
    const originalGetRecommendedPartSize = client.accountInfo.getRecommendedPartSize
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
})
