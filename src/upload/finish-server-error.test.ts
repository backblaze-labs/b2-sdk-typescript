import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Error, FinishLargeFileResponseBodyError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import type { CleanupFailureEvent } from './cancel.ts'

function errorResponse(status: number): HttpResponse {
  const body = {
    status,
    code: status === 400 ? 'bad_request' : 'service_unavailable',
    message: 'finish failed',
  }
  return {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

describe('finish response classification', () => {
  it.each([500, 503, 599])('keeps a committed file after a finish %i response', async (status) => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    const requests: string[] = []
    const transport: HttpTransport = {
      async send(req) {
        requests.push(req.url)
        if (req.url.includes('b2_finish_large_file')) {
          const completed = await inner.send(req)
          expect(completed.status).toBe(200)
          return errorResponse(status)
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
      bucketName: `finish-${status}`,
      bucketType: BucketType.AllPrivate,
    })
    const payload = deterministicBytes(200_000)
    const cleanup: CleanupFailureEvent[] = []
    const error = await bucket
      .upload({
        fileName: 'finish.bin',
        source: new BufferSource(payload),
        partSize: 100_000,
        onCleanupFailure: (event) => cleanup.push(event),
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(error).toBeInstanceOf(FinishLargeFileResponseBodyError)
    expect(error).toMatchObject({ bucketId: bucket.id, fileName: 'finish.bin', cause: { status } })
    expect(requests.some((url) => url.includes('b2_cancel_large_file'))).toBe(false)
    expect(cleanup).toHaveLength(1)
    expect(cleanup[0]).toMatchObject({ reason: 'finish-ambiguous' })
    expect(await readStream((await bucket.file('finish.bin').download()).body)).toEqual(payload)
  })

  it('cancels an unfinished file after a definite 400 finish rejection', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    const requests: string[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest) {
        requests.push(req.url)
        return req.url.includes('b2_finish_large_file') ? errorResponse(400) : inner.send(req)
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
      bucketName: 'finish-400',
      bucketType: BucketType.AllPrivate,
    })
    const error = await bucket
      .upload({
        fileName: 'failure.bin',
        source: new BufferSource(deterministicBytes(200_000)),
        partSize: 100_000,
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(error).toBeInstanceOf(B2Error)
    expect(error).toMatchObject({ status: 400 })
    expect(requests.some((url) => url.includes('b2_cancel_large_file'))).toBe(true)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files).toHaveLength(0)
  })
})
