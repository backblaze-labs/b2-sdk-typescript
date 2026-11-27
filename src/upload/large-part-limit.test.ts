import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes } from '../test-utils/index.ts'
import { resetRemoteSimulator } from '../test-utils/remote-simulator.ts'
import { BucketType } from '../types/bucket.ts'
import { uploadLargeFile } from './large.ts'

const PART_LIMIT_MESSAGE = /10[,_ ]?000|too many parts|part.*limit/i

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
  // Tiny simulator parts exercise the 10,000-part boundary with small fixtures.
  const sim = await resetRemoteSimulator({ minimumPartSize })
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
    realm: sim.realm,
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

describe('upload part limit', () => {
  it('rejects an oversized declared source before reading it or starting an upload', async () => {
    const { client, bucket, startCalls } = await recordingClient(1)
    const source = new BufferSource(deterministicBytes(1))
    Object.defineProperty(source, 'size', { value: 1_000_000_000_000 })
    Object.defineProperty(source, 'slice', {
      value: () => {
        throw new Error('source must not be read')
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'huge.bin',
        source,
        partSize: 1,
      }),
    ).rejects.toThrow(PART_LIMIT_MESSAGE)
    expect(startCalls).toHaveLength(0)
  })

  it('rejects a plan above 10,000 parts before starting the large file', async () => {
    const { client, bucket, startCalls } = await recordingClient(1)

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'too-many-parts.bin',
        source: new BufferSource(deterministicBytes(10_001)),
        partSize: 1,
        concurrency: 1,
      }),
    ).rejects.toThrow(PART_LIMIT_MESSAGE)

    expect(startCalls, 'b2_start_large_file must not be reached for 10,001 parts').toHaveLength(0)
  })

  it('still starts the large file for exactly 10,000 parts', async () => {
    const boundary = await recordingClient(1)
    await expect(
      uploadLargeFile(boundary.client.raw, boundary.client.accountInfo, {
        bucketId: boundary.bucket.id,
        fileName: 'ten-thousand-parts.bin',
        source: new BufferSource(deterministicBytes(10_000)),
        partSize: 1,
        concurrency: 1,
      }),
    ).rejects.toThrow(/stop here/)
    expect(boundary.startCalls).toHaveLength(1)
  })
})
