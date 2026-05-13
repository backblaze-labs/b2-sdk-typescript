import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { copyLargeFile } from './large.ts'

/**
 * Fast tier for `copyLargeFile`: only the small-content / mocked-transport
 * paths. Anything that round-trips multi-MB through the simulator's per-part
 * SHA-1 lives in `copy.slow.test.ts` so `pnpm test` stays under a minute.
 */

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

describe('copyLargeFile', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

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

  it('clamps a too-small partSize up to the account minimum and falls back to copyFile', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-clamp-min',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('tiny content under min part size')
    const uploaded = await bucket.upload({
      fileName: 'tiny.bin',
      source: new BufferSource(content),
    })

    // partSize: 1000 is below absoluteMinimumPartSize (5_000_000 in the
    // simulator). The orchestrator must clamp to the minimum, which then
    // exceeds the content length, taking the single-call fast path.
    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'tiny-copy.bin',
      partSize: 1000,
    })

    expect(copied.fileName).toBe('tiny-copy.bin')
    expect(copied.action).toBe('copy')
    expect(copied.contentLength).toBe(content.byteLength)
  })

  it('forwards contentType, fileInfo, and SSE overrides through the single-copy fast path', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    const captured: { endpoint: string; body: Record<string, unknown> }[] = []
    const transport = {
      async send(req: Parameters<typeof inner.send>[0]) {
        if (typeof req.body === 'string') {
          const endpoint = req.url.split('/').pop() ?? ''
          try {
            captured.push({ endpoint, body: JSON.parse(req.body) as Record<string, unknown> })
          } catch {
            // not all bodies are JSON
          }
        }
        return inner.send(req)
      },
    }
    const c = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await c.authorize()
    const bucket = await c.createBucket({
      bucketName: 'copy-meta-fast',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('fast path with metadata')
    const uploaded = await bucket.upload({
      fileName: 'meta-src.txt',
      source: new BufferSource(content),
    })

    const customInfo = { 'src-tag': 'hello', author: 'tester' }
    const copied = await copyLargeFile(c.raw, c.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'meta-fast.txt',
      partSize: 5_000_000,
      contentType: 'text/plain',
      fileInfo: customInfo,
      destinationServerSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
      sourceServerSideEncryption: { mode: 'none' },
    })

    expect(copied.fileName).toBe('meta-fast.txt')

    const copyFileCall = captured.find((c) => c.endpoint === 'b2_copy_file')
    expect(copyFileCall).toBeDefined()
    const body = copyFileCall?.body ?? {}
    expect(body['contentType']).toBe('text/plain')
    expect(body['fileInfo']).toEqual(customInfo)
    expect(body['destinationServerSideEncryption']).toEqual({
      mode: 'SSE-B2',
      algorithm: 'AES256',
    })
    expect(body['sourceServerSideEncryption']).toEqual({ mode: 'none' })
  })
})
