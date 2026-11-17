// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import { copyLargeFile } from '../../src/copy/large.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { deterministicBytes, makeClient } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

async function smallPartClient() {
  const sim = new B2Simulator({ minimumPartSize: 100_000 })
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  await client.authorize()
  return client
}

describe('copy known defects', () => {
  it('multipart copy preserves the source fileInfo when none is supplied', async () => {
    const client = await smallPartClient()
    const bucket = await client.createBucket({
      bucketName: 'copy-c7',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'src.bin',
      source: new BufferSource(deterministicBytes(200_000)),
      partSize: 100_000,
      concurrency: 1,
      fileInfo: { 'src-tag': 'keep-me' },
    })

    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'dst.bin',
      partSize: 100_000,
      concurrency: 1,
    })

    expect(copied.fileInfo, 'source fileInfo was not carried over to the copy').toMatchObject({
      'src-tag': 'keep-me',
    })
  })

  it('Bucket.copyFile without destinationBucketId copies into this bucket', async () => {
    const { client } = makeClient()
    await client.authorize()
    const src = await client.createBucket({
      bucketName: 'copy-c23-src',
      bucketType: BucketType.AllPrivate,
    })
    const dst = await client.createBucket({
      bucketName: 'copy-c23-dst',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await src.upload({
      fileName: 'a.txt',
      source: new BufferSource(new TextEncoder().encode('hello')),
    })

    const copied = await dst.copyFile({ sourceFileId: uploaded.fileId, fileName: 'b.txt' })

    expect(copied.bucketId, 'copy landed in a different bucket than expected').toBe(dst.id)
  })

  it('multipart copy rejects a plan above 10,000 parts before starting the large file', async () => {
    const sim = new B2Simulator({ minimumPartSize: 1 })
    const inner = sim.transport()
    const startCalls: string[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_start_large_file')) {
          startCalls.push(req.url)
          // Fail fast so the unfixed code does not copy 10,001 parts.
          return failure()
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-c6',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'src.bin',
      source: new BufferSource(deterministicBytes(10_001)),
    })

    await expect(
      copyLargeFile(client.raw, client.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'dst.bin',
        partSize: 1,
        concurrency: 1,
      }),
    ).rejects.toThrow()
    expect(startCalls, 'b2_start_large_file must not be reached for 10,001 parts').toHaveLength(0)
  })
})

function failure(): HttpResponse {
  const body = { status: 400, code: 'bad_request', message: 'stop here' }
  return {
    status: 400,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}
