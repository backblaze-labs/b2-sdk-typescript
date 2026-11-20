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
import { deterministicBytes } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

describe('copy known defects', () => {
  it('multipart copy rejects a plan above 10,000 parts before starting the large file', async () => {
    const { client, bucket, startCalls } = await startCountingClient('copy-c6')
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
    ).rejects.toThrow(/10[,_ ]?000|too many parts|part.*limit/i)
    expect(startCalls, 'b2_start_large_file must not be reached for 10,001 parts').toHaveLength(0)
  })

  it('multipart copy of exactly 10,000 parts still reaches b2_start_large_file', async () => {
    // Boundary control: a general early failure must not satisfy the validation test above.
    // The transport answers b2_start_large_file with a 400, so reaching it surfaces as that error.
    const { client, bucket, startCalls } = await startCountingClient('copy-c6-boundary')
    const uploaded = await bucket.upload({
      fileName: 'src.bin',
      source: new BufferSource(deterministicBytes(10_000)),
    })

    await expect(
      copyLargeFile(client.raw, client.accountInfo, {
        sourceFileId: uploaded.fileId,
        fileName: 'dst.bin',
        partSize: 1,
        concurrency: 1,
      }),
    ).rejects.toThrow(/stop here/)
    expect(startCalls, 'a valid 10,000-part copy must reach b2_start_large_file').toHaveLength(1)
  })
})

async function startCountingClient(bucketName: string) {
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
  const bucket = await client.createBucket({ bucketName, bucketType: BucketType.AllPrivate })
  return { client, bucket, startCalls }
}

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
