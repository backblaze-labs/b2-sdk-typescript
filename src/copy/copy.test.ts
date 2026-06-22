import { beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deferred, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { copyLargeFile } from './large.ts'

/**
 * Fast tier for `copyLargeFile`: only the small-content / mocked-transport
 * paths. Anything that round-trips multi-MB through the simulator's per-part
 * SHA-1 lives in `copy.slow.test.ts` so `pnpm test` stays under a minute.
 */

describe('copyLargeFile', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('falls back to single copyFile when source fits in one part', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-small-src',
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
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

  it('waits for pending copy parts before cleanup after a part failure', async () => {
    const { client: c } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await c.authorize()
    const bucket = await c.createBucket({
      bucketName: 'copy-settle-before-cleanup',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'copy-race-src.bin',
      source: new BufferSource(new Uint8Array(200_000)),
      partSize: 100_000,
      concurrency: 1,
    })

    const secondCopyStarted = deferred<void>()
    const releaseSecondCopy = deferred<void>()
    const originalCopyPart = c.raw.copyPart.bind(c.raw)
    const originalCancelLargeFile = c.raw.cancelLargeFile.bind(c.raw)
    let secondCopySettled = false
    const copyPart = vi.spyOn(c.raw, 'copyPart').mockImplementation(async (...args) => {
      const callNumber = copyPart.mock.calls.length
      if (callNumber === 1) {
        await secondCopyStarted.promise
        throw new Error('forced first copy_part failure')
      }
      if (callNumber === 2) {
        secondCopyStarted.resolve(undefined)
        await releaseSecondCopy.promise
        const response = await originalCopyPart(...args)
        secondCopySettled = true
        return response
      }
      return originalCopyPart(...args)
    })
    const cancelLargeFile = vi
      .spyOn(c.raw, 'cancelLargeFile')
      .mockImplementation(async (...args) => {
        expect(secondCopySettled).toBe(true)
        return originalCancelLargeFile(...args)
      })

    const copy = copyLargeFile(c.raw, c.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'copy-race-dst.bin',
      partSize: 100_000,
      concurrency: 2,
    })
    await secondCopyStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelLargeFile).not.toHaveBeenCalled()

    releaseSecondCopy.resolve(undefined)
    await expect(copy).rejects.toThrow('forced first copy_part failure')
    expect(cancelLargeFile).toHaveBeenCalledTimes(1)
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
      bucketType: BucketType.AllPrivate,
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
      destinationServerSideEncryption: {
        mode: EncryptionMode.SseB2,
        algorithm: EncryptionAlgorithm.Aes256,
      },
      sourceServerSideEncryption: { mode: EncryptionMode.None },
    })

    expect(copied.fileName).toBe('meta-fast.txt')

    const copyFileCall = captured.find((c) => c.endpoint === 'b2_copy_file')
    expect(copyFileCall).toBeDefined()
    const body = copyFileCall?.body ?? {}
    expect(body['contentType']).toBe('text/plain')
    expect(body['fileInfo']).toEqual(customInfo)
    expect(body['destinationServerSideEncryption']).toEqual({
      mode: EncryptionMode.SseB2,
      algorithm: EncryptionAlgorithm.Aes256,
    })
    expect(body['sourceServerSideEncryption']).toEqual({ mode: EncryptionMode.None })
  })

  it('Bucket.copyFile maps destination and source SSE options to the raw request', async () => {
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
      bucketName: 'copy-bucket-sse',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('bucket copy sse')
    const uploaded = await bucket.upload({
      fileName: 'bucket-sse-src.txt',
      source: new BufferSource(content),
    })

    const destinationSse = {
      mode: EncryptionMode.SseB2,
      algorithm: EncryptionAlgorithm.Aes256,
    } as const
    const sourceSse = {
      mode: EncryptionMode.SseC,
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey: 'customer-key',
      customerKeyMd5: 'customer-key-md5',
    } as const
    const preferredDestination = { mode: EncryptionMode.None } as const

    await bucket.copyFile({
      sourceFileId: uploaded.fileId,
      fileName: 'destination-field.txt',
      destinationServerSideEncryption: destinationSse,
      sourceServerSideEncryption: sourceSse,
    })
    await bucket.copyFile({
      sourceFileId: uploaded.fileId,
      fileName: 'deprecated-alias.txt',
      serverSideEncryption: destinationSse,
    })
    await bucket.copyFile({
      sourceFileId: uploaded.fileId,
      fileName: 'preferred-field.txt',
      serverSideEncryption: destinationSse,
      destinationServerSideEncryption: preferredDestination,
    })
    await bucket.copyFile({
      sourceFileId: uploaded.fileId,
      fileName: 'plain-copy.txt',
    })

    const copyFileBodies = captured.filter((c) => c.endpoint === 'b2_copy_file').map((c) => c.body)
    expect(copyFileBodies).toHaveLength(4)
    expect(copyFileBodies[0]?.['destinationServerSideEncryption']).toEqual(destinationSse)
    expect(copyFileBodies[0]?.['sourceServerSideEncryption']).toEqual(sourceSse)
    expect(copyFileBodies[0]?.['serverSideEncryption']).toBeUndefined()
    expect(copyFileBodies[1]?.['destinationServerSideEncryption']).toEqual(destinationSse)
    expect(copyFileBodies[1]?.['serverSideEncryption']).toBeUndefined()
    expect(copyFileBodies[2]?.['destinationServerSideEncryption']).toEqual(preferredDestination)
    expect(copyFileBodies[3]?.['destinationServerSideEncryption']).toBeUndefined()
    expect(copyFileBodies[3]?.['sourceServerSideEncryption']).toBeUndefined()
    expect(copyFileBodies[3]?.['serverSideEncryption']).toBeUndefined()
  })
})
