// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { deterministicBytes } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'
import { uploadLargeFile } from '../../src/upload/large.ts'

function stop400(): HttpResponse {
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

async function recordingClient(minimumPartSize: number) {
  const sim = new B2Simulator({ minimumPartSize })
  const inner = sim.transport()
  const startCalls: string[] = []
  const transport: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      if (req.url.includes('b2_start_large_file')) {
        startCalls.push(req.url)
        return stop400()
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
    bucketName: 'large-kd',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket, startCalls }
}

describe('uploadLargeFile known defects', () => {
  it('concurrency 0 fails fast, before hashing the source or starting the large file', async () => {
    const { client, bucket, startCalls } = await recordingClient(100_000)
    const inner = new BufferSource(deterministicBytes(200_000))
    let slices = 0
    const source = Object.create(inner) as BufferSource
    Object.defineProperty(source, 'slice', {
      value: (start: number, end: number) => {
        slices++
        return inner.slice(start, end)
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'zero-concurrency.bin',
        source,
        partSize: 100_000,
        concurrency: 0,
      }),
    ).rejects.toThrow(/concurrency/i)

    expect(slices, 'source was read before the invalid option was rejected').toBe(0)
    expect(
      startCalls,
      'b2_start_large_file was sent before the invalid option was rejected',
    ).toHaveLength(0)
  })

  it('still starts the large file for a valid concurrency', async () => {
    // A general early failure must not satisfy the validation test above.
    // The recording transport answers b2_start_large_file with a 400, so reaching it surfaces
    // as that specific error.
    const valid = await recordingClient(100_000)
    await expect(
      uploadLargeFile(valid.client.raw, valid.client.accountInfo, {
        bucketId: valid.bucket.id,
        fileName: 'one-concurrency.bin',
        source: new BufferSource(deterministicBytes(200_000)),
        partSize: 100_000,
        concurrency: 1,
      }),
    ).rejects.toThrow(/stop here/)
    expect(valid.startCalls).toHaveLength(1)
  })
})
