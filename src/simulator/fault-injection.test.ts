import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { BufferSource } from '../streams/source.ts'
import { BucketType } from '../types/bucket.ts'
import { B2Simulator } from './index.ts'

/**
 * Behavioural contract for `B2Simulator.injectFailure` /
 * `clearFaults` / `consumeMatchingFault`. These tests pin the matching
 * order, the skip + count budget, retire-on-zero, clear-by-handle, and
 * the synthesized response shape (status, code, body, optional
 * Retry-After header).
 */

describe('B2Simulator.injectFailure', () => {
  let sim: B2Simulator
  let client: B2Client

  beforeEach(async () => {
    sim = new B2Simulator()
    client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
  })

  it('fails a matched endpoint with a synthesized 503 + body', async () => {
    sim.injectFailure({ on: 'b2_create_bucket' })
    await expect(
      client.createBucket({ bucketName: 'fault-1', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/simulated failure/)
  })

  it('honors a custom status + code + message', async () => {
    sim.injectFailure({
      on: 'b2_create_bucket',
      status: 400,
      code: 'bad_bucket_name',
      message: 'simulated bad name',
    })
    await expect(
      client.createBucket({ bucketName: 'fault-2', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/simulated bad name/)
  })

  it('decrements count and retires after the budget is spent', async () => {
    // Fail the next 2 createBucket calls then succeed on the 3rd.
    sim.injectFailure({ on: 'b2_create_bucket', count: 2 })
    await expect(
      client.createBucket({ bucketName: 'fail-1', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow()
    await expect(
      client.createBucket({ bucketName: 'fail-2', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow()
    // Third call must succeed: budget spent + auto-retire.
    const bucket = await client.createBucket({
      bucketName: 'succeed',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('succeed')
  })

  it('skips the first N matched calls before failing', async () => {
    // Let the first 2 succeed, fail the 3rd.
    sim.injectFailure({ on: 'b2_create_bucket', skip: 2, count: 1 })
    const b1 = await client.createBucket({
      bucketName: 'skip-1',
      bucketType: BucketType.AllPrivate,
    })
    const b2 = await client.createBucket({
      bucketName: 'skip-2',
      bucketType: BucketType.AllPrivate,
    })
    expect(b1.name).toBe('skip-1')
    expect(b2.name).toBe('skip-2')
    await expect(
      client.createBucket({ bucketName: 'skip-3-fails', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow()
    // 4th matches but the count budget is exhausted: succeeds.
    const b4 = await client.createBucket({
      bucketName: 'skip-4',
      bucketType: BucketType.AllPrivate,
    })
    expect(b4.name).toBe('skip-4')
  })

  it('emits a Retry-After header when requested', async () => {
    // We inspect via the raw transport to read the header directly.
    sim.injectFailure({
      on: 'b2_create_bucket',
      status: 429,
      code: 'too_many_requests',
      retryAfter: 7,
    })
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_bucket',
      headers: { Authorization: 'sim_auth_token' },
      body: JSON.stringify({ bucketName: 'rt-test', bucketType: 'allPrivate' }),
    })
    expect(resp.status).toBe(429)
    expect(resp.headers.get('Retry-After')).toBe('7')
  })

  it('clears a single fault via the returned handle', async () => {
    const handle = sim.injectFailure({ on: 'b2_create_bucket' })
    // Register a second fault that should NOT be cleared by the first handle.
    sim.injectFailure({ on: 'b2_list_buckets', count: 1 })
    handle.clear()
    // First create now succeeds because its fault was cleared.
    const bucket = await client.createBucket({
      bucketName: 'cleared',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('cleared')
    // The other fault is still in effect.
    await expect(client.listBuckets()).rejects.toThrow()
  })

  it('clearFaults() removes every registration', async () => {
    sim.injectFailure({ on: 'b2_create_bucket' })
    sim.injectFailure({ on: 'b2_list_buckets' })
    sim.clearFaults()
    const bucket = await client.createBucket({
      bucketName: 'fresh-bucket',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('fresh-bucket')
    const buckets = await client.listBuckets()
    expect(buckets.length).toBe(1)
  })

  it('consumes faults in registration order when multiple match the same URL', async () => {
    // First fault retires after 1 call, second handles the rest. We
    // distinguish via the message because typed `B2Error.message`
    // surfaces the response body's message field; the code maps to a
    // specific subclass but isn't always in the user-visible string.
    sim.injectFailure({
      on: 'b2_create_bucket',
      status: 400,
      code: 'bad_request',
      message: 'first_fault',
      count: 1,
    })
    sim.injectFailure({
      on: 'b2_create_bucket',
      status: 503,
      code: 'service_unavailable',
      message: 'second_fault',
    })
    await expect(
      client.createBucket({ bucketName: 'fault-a', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/first_fault/i)
    await expect(
      client.createBucket({ bucketName: 'fault-b', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/second_fault/i)
  })

  it('passes through unmatched requests untouched', async () => {
    // A fault on a different endpoint must NOT affect this one.
    sim.injectFailure({ on: 'b2_list_buckets' })
    const bucket = await client.createBucket({
      bucketName: 'unmatched',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('unmatched')
  })

  it('matches on upload requests too (b2_upload_part)', async () => {
    // Set up a multipart upload-ready bucket with small parts so the test
    // fits in the fast tier. `recommendedPartSize` must also be low so
    // `Bucket.upload()`'s small-vs-large dispatch picks the multipart
    // path for a small payload.
    const smallSim = new B2Simulator({
      minimumPartSize: 100_000,
      recommendedPartSize: 100_000,
    })
    const c = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: smallSim.transport(),
      retry: { maxRetries: 0 },
    })
    await c.authorize()
    const b = await c.createBucket({
      bucketName: 'upload-fault',
      bucketType: BucketType.AllPrivate,
    })
    // Important: `on` is a substring match, and `b2_get_upload_part_url`
    // contains `b2_upload_part` as a substring. To target ONLY the part
    // upload (and not its URL-fetch precursor), match on the `?fileId=`
    // query-string that the simulator appends to part-upload URLs.
    smallSim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 503,
      message: 'part-upload-failed',
      count: 1,
    })
    await expect(
      b.upload({
        fileName: 'fault.bin',
        source: new BufferSource(new Uint8Array(200_000)),
        partSize: 100_000,
        concurrency: 1,
      }),
    ).rejects.toThrow(/part-upload-failed/)
  })

  it('matches on download requests too (b2_download_file_by_id)', async () => {
    const bucket = await client.createBucket({
      bucketName: 'download-fault',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'd.txt',
      source: new BufferSource(new TextEncoder().encode('hello')),
    })
    sim.injectFailure({
      on: 'b2_download_file_by_id',
      status: 503,
      message: 'download-failed',
    })
    await expect(bucket.file('d.txt').downloadById(uploaded.fileId)).rejects.toThrow(
      /download-failed/,
    )
  })
})
