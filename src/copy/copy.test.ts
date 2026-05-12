import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { copyLargeFile } from './large.ts'

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

function deterministic(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

// Multipart copy tests round-trip ~5 MB through upload + b2_copy_part + download
// + content-equality assertion. The simulator computes real SHA-1s for each
// part, so wall-clock scales with how fast the runner can hash. macOS GitHub
// runners are ~2-3x slower than local Macs for this workload, and the
// previously-hardcoded 30 s timeout was getting clipped on bad scheduling
// ticks. Match the upload.test.ts calibration (60 s).
const LARGE_TEST_TIMEOUT = 60_000

describe('copyLargeFile', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it(
    'multipart-copies a file whose size exceeds partSize',
    async () => {
      const bucket = await client.createBucket({
        bucketName: 'copy-large-src',
        bucketType: 'allPrivate',
      })

      const content = deterministic(5_000_010)
      const uploaded = await bucket.upload({
        fileName: 'big.bin',
        source: new BufferSource(content),
        partSize: 5_000_000,
        concurrency: 1,
      })

      const copied = await copyLargeFile(client.raw, client.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'big-copy.bin',
        partSize: 5_000_000,
        concurrency: 1,
      })

      expect(copied.fileName).toBe('big-copy.bin')
      expect(copied.contentLength).toBe(content.byteLength)

      const dl = await bucket.download('big-copy.bin')
      const data = await readStream(dl.body)
      expect(data).toEqual(content)
    },
    LARGE_TEST_TIMEOUT,
  )

  it('falls back to single copyFile when source fits in one part', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-small-src',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('small enough for one part')
    const uploaded = await bucket.upload({
      fileName: 'small.bin',
      source: new BufferSource(content),
    })

    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'small-copy.bin',
      partSize: 5_000_000,
    })

    expect(copied.fileName).toBe('small-copy.bin')
    expect(copied.action).toBe('copy')

    const dl = await bucket.download('small-copy.bin')
    const data = await readStream(dl.body)
    expect(new TextDecoder().decode(data)).toBe('small enough for one part')
  })

  it('Bucket.copyLargeFile() exposes the orchestrator on the bucket handle', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-bucket-method',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('via bucket method')
    const uploaded = await bucket.upload({
      fileName: 'src.txt',
      source: new BufferSource(content),
    })

    const copied = await bucket.copyLargeFile({
      sourceFileId: uploaded.fileId,
      fileName: 'dst.txt',
      partSize: 5_000_000,
    })

    expect(copied.fileName).toBe('dst.txt')
  })

  it(
    'cancels the unfinished large file when a copyPart fails',
    async () => {
      const sim = new B2Simulator()
      const inner = sim.transport()
      let copyPartCalls = 0
      const transport = {
        async send(req: Parameters<typeof inner.send>[0]) {
          if (req.url.includes('b2_copy_part')) {
            copyPartCalls++
            if (copyPartCalls > 1) throw new Error('forced copy_part failure')
          }
          return inner.send(req)
        },
      }
      const c = new B2Client({
        applicationKeyId: 'k',
        applicationKey: 'k',
        transport,
        retry: { maxRetries: 0 },
      })
      await c.authorize()
      const bucket = await c.createBucket({
        bucketName: 'copy-fail',
        bucketType: 'allPrivate',
      })
      const content = deterministic(15_000_000)
      const uploaded = await bucket.upload({
        fileName: 'src.bin',
        source: new BufferSource(content),
        partSize: 5_000_000,
        concurrency: 1,
      })

      await expect(
        copyLargeFile(c.raw, c.accountInfo, {
          sourceFileId: uploaded.fileId,
          fileName: 'fail-copy.bin',
          partSize: 5_000_000,
          concurrency: 1,
        }),
      ).rejects.toThrow(/copy_part failure/)

      const unfinished = await c.raw.listUnfinishedLargeFiles(
        c.accountInfo.getApiUrl(),
        c.accountInfo.getAuthToken(),
        { bucketId: bucket.id },
      )
      expect(unfinished.files.find((f) => f.fileName === 'fail-copy.bin')).toBeUndefined()
    },
    LARGE_TEST_TIMEOUT,
  )

  it(
    'copies across buckets',
    async () => {
      const src = await client.createBucket({
        bucketName: 'copy-cross-src',
        bucketType: 'allPrivate',
      })
      const dst = await client.createBucket({
        bucketName: 'copy-cross-dst',
        bucketType: 'allPrivate',
      })

      const content = deterministic(5_000_010)
      const uploaded = await src.upload({
        fileName: 'src.bin',
        source: new BufferSource(content),
        partSize: 5_000_000,
        concurrency: 1,
      })

      const copied = await copyLargeFile(client.raw, client.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'cross.bin',
        destinationBucketId: dst.id,
        partSize: 5_000_000,
        concurrency: 1,
      })

      expect(copied.fileName).toBe('cross.bin')

      const dl = await dst.download('cross.bin')
      const data = await readStream(dl.body)
      expect(data).toEqual(content)
    },
    LARGE_TEST_TIMEOUT,
  )
})
