import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { copyLargeFile } from './large.ts'

/**
 * Slow tier for `copyLargeFile`: every test that round-trips multi-MB through
 * upload + `b2_copy_part` + download with simulator-side SHA-1 verification.
 * Lives in a `*.slow.test.ts` file so `pnpm test` (fast feedback) skips it;
 * `pnpm test:slow` / `pnpm test:coverage` pick it up. The slow vitest config
 * pins `maxForks: 1` and `testTimeout: 180_000`, so individual tests don't
 * need their own timeout arguments.
 */

describe('copyLargeFile (slow)', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('multipart-copies a file whose size exceeds partSize', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-large-src',
      bucketType: BucketType.AllPrivate,
    })

    const content = deterministicBytes(5_000_010)
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
  })

  it('cancels the unfinished large file when a copyPart fails', async () => {
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
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(15_000_000)
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
  })

  it('copies across buckets', async () => {
    const src = await client.createBucket({
      bucketName: 'copy-cross-src',
      bucketType: BucketType.AllPrivate,
    })
    const dst = await client.createBucket({
      bucketName: 'copy-cross-dst',
      bucketType: BucketType.AllPrivate,
    })

    const content = deterministicBytes(5_000_010)
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
  })

  it('forwards contentType, fileInfo, and SSE overrides through the multipart path', async () => {
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
      bucketName: 'copy-meta-multi',
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(10_000_000)
    const uploaded = await bucket.upload({
      fileName: 'meta-multi-src.bin',
      source: new BufferSource(content),
      partSize: 5_000_000,
      concurrency: 1,
    })

    const customInfo = { 'src-tag': 'mp', stage: 'overrides' }
    const sseDest = { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 } as const
    const sseSrc = { mode: EncryptionMode.None } as const
    const copied = await copyLargeFile(c.raw, c.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'meta-multi.bin',
      partSize: 5_000_000,
      concurrency: 1,
      contentType: 'application/octet-stream',
      fileInfo: customInfo,
      destinationServerSideEncryption: sseDest,
      sourceServerSideEncryption: sseSrc,
    })

    expect(copied.fileName).toBe('meta-multi.bin')

    const startCall = captured.find((c) => c.endpoint === 'b2_start_large_file')
    expect(startCall).toBeDefined()
    const startBody = startCall?.body ?? {}
    expect(startBody['contentType']).toBe('application/octet-stream')
    expect(startBody['fileInfo']).toEqual(customInfo)
    expect(startBody['serverSideEncryption']).toEqual(sseDest)

    const copyPartCalls = captured.filter((c) => c.endpoint === 'b2_copy_part')
    expect(copyPartCalls.length).toBeGreaterThan(0)
    for (const part of copyPartCalls) {
      expect(part.body['sourceServerSideEncryption']).toEqual(sseSrc)
      expect(part.body['destinationServerSideEncryption']).toEqual(sseDest)
    }
  })

  it('inherits source contentType when no override is supplied', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    const startBodies: Record<string, unknown>[] = []
    const transport = {
      async send(req: Parameters<typeof inner.send>[0]) {
        if (typeof req.body === 'string' && req.url.includes('b2_start_large_file')) {
          try {
            startBodies.push(JSON.parse(req.body) as Record<string, unknown>)
          } catch {
            // ignore
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
      bucketName: 'copy-inherit-ct',
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(10_000_000)
    const uploaded = await bucket.upload({
      fileName: 'inherit-src.bin',
      source: new BufferSource(content),
      partSize: 5_000_000,
      concurrency: 1,
      contentType: 'image/png',
    })

    const copied = await copyLargeFile(c.raw, c.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'inherit-dst.bin',
      partSize: 5_000_000,
      concurrency: 1,
    })

    expect(copied.fileName).toBe('inherit-dst.bin')
    expect(startBodies.length).toBe(1)
    expect(startBodies[0]?.['contentType']).toBe('image/png')
    // Default fileInfo is the empty object when no override is supplied.
    expect(startBodies[0]?.['fileInfo']).toEqual({})
    // No SSE override means the field is omitted from start_large_file.
    expect(startBodies[0]?.['serverSideEncryption']).toBeUndefined()
  })

  it('multipart-copies with default concurrency when none is specified', async () => {
    // Uses a small-part simulator so this default-concurrency branch test
    // stays under the ~60 s vitest IPC RPC budget when v8 coverage
    // instrumentation is on. The default-of-4 branch in copyLargeFile is
    // independent of part size.
    const smallSim = new B2Simulator({ minimumPartSize: 100_000 })
    const smallClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: smallSim.transport(),
    })
    await smallClient.authorize()
    const bucket = await smallClient.createBucket({
      bucketName: 'copy-default-conc',
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(200_000)
    const uploaded = await bucket.upload({
      fileName: 'def-conc-src.bin',
      source: new BufferSource(content),
      partSize: 100_000,
      concurrency: 1,
    })

    const copied = await copyLargeFile(smallClient.raw, smallClient.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'def-conc-dst.bin',
      partSize: 100_000,
      // concurrency omitted: exercises the default-of-4 branch.
    })

    expect(copied.fileName).toBe('def-conc-dst.bin')
    expect(copied.contentLength).toBe(content.byteLength)

    const dl = await bucket.download('def-conc-dst.bin')
    const data = await readStream(dl.body)
    expect(data).toEqual(content)
  })

  it('handles exact N-part boundary where size equals N * partSize', async () => {
    // Uses a small-part simulator so the exact-N-part-boundary control-flow
    // test stays under the ~60 s vitest IPC RPC budget when v8 coverage
    // instrumentation is on. The boundary logic is independent of part size.
    const smallSim = new B2Simulator({ minimumPartSize: 100_000 })
    const smallClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: smallSim.transport(),
    })
    await smallClient.authorize()
    const bucket = await smallClient.createBucket({
      bucketName: 'copy-exact-boundary',
      bucketType: BucketType.AllPrivate,
    })
    // Exactly 2 parts of 100_000 each, no remainder.
    const content = deterministicBytes(200_000)
    const uploaded = await bucket.upload({
      fileName: 'exact-src.bin',
      source: new BufferSource(content),
      partSize: 100_000,
      concurrency: 1,
    })

    const copied = await copyLargeFile(smallClient.raw, smallClient.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'exact-dst.bin',
      partSize: 100_000,
      concurrency: 1,
    })

    expect(copied.fileName).toBe('exact-dst.bin')
    expect(copied.contentLength).toBe(content.byteLength)

    const dl = await bucket.download('exact-dst.bin')
    const data = await readStream(dl.body)
    expect(data).toEqual(content)
  })

  it('cancels the unfinished large file when b2_finish_large_file fails', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    const transport = {
      async send(req: Parameters<typeof inner.send>[0]) {
        if (req.url.includes('b2_finish_large_file')) {
          throw new Error('forced finish failure')
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
      bucketName: 'copy-finish-fail',
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(10_000_000)
    const uploaded = await bucket.upload({
      fileName: 'finish-src.bin',
      source: new BufferSource(content),
      partSize: 5_000_000,
      concurrency: 1,
    })

    await expect(
      copyLargeFile(c.raw, c.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'finish-fail.bin',
        partSize: 5_000_000,
        concurrency: 1,
      }),
    ).rejects.toThrow(/finish failure/)

    const unfinished = await c.raw.listUnfinishedLargeFiles(
      c.accountInfo.getApiUrl(),
      c.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'finish-fail.bin')).toBeUndefined()
  })

  it('swallows errors from b2_cancel_large_file during cleanup', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let copyPartCalls = 0
    const transport = {
      async send(req: Parameters<typeof inner.send>[0]) {
        if (req.url.includes('b2_copy_part')) {
          copyPartCalls++
          if (copyPartCalls > 1) throw new Error('forced copy_part failure')
        }
        if (req.url.includes('b2_cancel_large_file')) {
          throw new Error('forced cancel failure')
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
      bucketName: 'copy-cancel-fail',
      bucketType: BucketType.AllPrivate,
    })
    const content = deterministicBytes(15_000_000)
    const uploaded = await bucket.upload({
      fileName: 'cancel-src.bin',
      source: new BufferSource(content),
      partSize: 5_000_000,
      concurrency: 1,
    })

    // The orchestrator must surface the original copy_part error,
    // not the secondary failure from the best-effort cancel call.
    await expect(
      copyLargeFile(c.raw, c.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'cancel-fail.bin',
        partSize: 5_000_000,
        concurrency: 1,
      }),
    ).rejects.toThrow(/copy_part failure/)
  })
})
