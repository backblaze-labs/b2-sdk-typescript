import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { deterministicBytes, readStream } from '../test-utils/index.ts'
import { resetRemoteSimulator } from '../test-utils/remote-simulator.ts'
import { BucketType } from '../types/bucket.ts'

type Intercept = (req: HttpRequest) => Promise<HttpResponse | undefined> | HttpResponse | undefined

async function makeStreamClient(minimumPartSize: number, intercept: Intercept = () => undefined) {
  // Tiny simulator parts exercise the 10,000-part boundary with small fixtures.
  const sim = await resetRemoteSimulator({ minimumPartSize })
  const inner = sim.transport()
  const seen: HttpRequest[] = []
  // URLs of requests whose response has been fully produced (a request is in
  // `seen` as soon as it starts; it is in `completed` once it has answered).
  const completed: string[] = []
  const transport: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req)
      const resp = (await intercept(req)) ?? (await inner.send(req))
      completed.push(req.url)
      return resp
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
    bucketName: 'stream-kd',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket, sim, seen, completed }
}

const PART_LIMIT_MESSAGE = /10[,_ ]?000|too many parts|part.*limit/i

describe('stream part limit', () => {
  it.each([1, 2])(
    'handles %i extra bytes with a buffered partial part near the limit',
    async (extraBytes) => {
      // Tiny simulator parts make the 10,000-part boundary inexpensive to exercise.
      const { client, bucket, seen } = await makeStreamClient(2)
      const payload = deterministicBytes(19_999)
      const suffix = deterministicBytes(extraBytes)
      const object = bucket.file(`c6-carry-${extraBytes}.bin`)
      const { writable, done } = object.createWriteStream({ partSize: 2, concurrency: 4 })
      const writer = writable.getWriter()
      await writer.write(payload)
      if (extraBytes === 1) {
        await writer.write(suffix)
        await writer.close()
        await done
        const stored = await readStream((await object.download()).body)
        expect(stored).toEqual(new Uint8Array([...payload, ...suffix]))
        expect(seen.filter((r) => r.url.includes('b2_upload_part'))).toHaveLength(10_000)
      } else {
        await expect(writer.write(suffix)).rejects.toThrow(PART_LIMIT_MESSAGE)
        await expect(done).rejects.toThrow(PART_LIMIT_MESSAGE)
        expect(seen.some((r) => r.url.includes('b2_cancel_large_file'))).toBe(true)
        expect(seen.some((r) => r.url.includes('b2_finish_large_file'))).toBe(false)
        const unfinished = await client.raw.listUnfinishedLargeFiles(
          client.accountInfo.getApiUrl(),
          client.accountInfo.getAuthToken(),
          { bucketId: bucket.id },
        )
        expect(unfinished.files.some((f) => f.fileName === object.fileName)).toBe(false)
      }
    },
    60_000,
  )

  it('rejects a partial 10,001st part and cancels without waiting for close', async () => {
    const { client, bucket, seen } = await makeStreamClient(2)
    const { writable, done } = bucket.file('c6-partial.bin').createWriteStream({
      partSize: 2,
      concurrency: 4,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(20_000))
    await expect(writer.write(deterministicBytes(1))).rejects.toThrow(PART_LIMIT_MESSAGE)
    await expect(done).rejects.toThrow(PART_LIMIT_MESSAGE)
    expect(seen.some((r) => r.url.includes('b2_cancel_large_file'))).toBe(true)
    expect(seen.some((r) => r.url.includes('b2_finish_large_file'))).toBe(false)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.some((f) => f.fileName === 'c6-partial.bin')).toBe(false)
  }, 60_000)

  it('never ships part number 10,001', async () => {
    const { bucket, seen } = await makeStreamClient(1)
    const { writable, done } = bucket.file('c6.bin').createWriteStream({
      partSize: 1,
      concurrency: 4,
    })
    const writer = writable.getWriter()
    const writeOutcome = await writer.write(deterministicBytes(10_001)).then(
      () => undefined,
      (error: unknown) => error,
    )
    const closeOutcome = await writer.close().then(
      () => undefined,
      (error: unknown) => error,
    )
    const doneOutcome = await done.then(
      () => undefined,
      (error: unknown) => error,
    )

    // The stream cannot represent 10,001 parts, so it must reject, and say why.
    expect(writeOutcome).toBeInstanceOf(RangeError)
    expect((writeOutcome as Error).message).toBe('A large file cannot exceed 10000 parts.')
    expect(closeOutcome, 'close must preserve the part-limit reason').toBe(writeOutcome)
    expect(doneOutcome, 'done must preserve the part-limit reason').toBe(writeOutcome)
    await expect(writer.closed).rejects.toBe(writeOutcome)
    const partNumbers = seen
      .filter((r) => r.url.includes('b2_upload_part'))
      .map((r) => Number(r.headers?.['X-Bz-Part-Number']))
    expect(
      Math.max(0, ...partNumbers),
      'a part number above 10,000 was uploaded',
    ).toBeLessThanOrEqual(10_000)
  }, 60_000)

  it('preserves the part-limit reason when closing the unlocked stream', async () => {
    const { bucket } = await makeStreamClient(1)
    const { writable, done } = bucket.file('c6-unlocked.bin').createWriteStream({ partSize: 1 })
    const writer = writable.getWriter()
    const reason = await writer.write(deterministicBytes(10_001)).catch((error: unknown) => error)
    expect(reason).toBeInstanceOf(RangeError)
    expect((reason as Error).message).toMatch(PART_LIMIT_MESSAGE)
    writer.releaseLock()

    // A released writer still reports its own invalid usage, even after a new writer acquires it.
    const nextWriter = writable.getWriter()
    await expect(writer.close()).rejects.toBeInstanceOf(TypeError)
    await expect(writable.close()).rejects.toBeInstanceOf(TypeError)
    await expect(nextWriter.close()).rejects.toBe(reason)
    nextWriter.releaseLock()
    await expect(writable.close()).rejects.toBe(reason)
    await expect(done).rejects.toBe(reason)
  })

  it.each(['writer', 'stream'] as const)(
    'keeps native %s close errors after a non-part-limit abort',
    async (surface) => {
      const { bucket } = await makeStreamClient(1)
      const { writable, done } = bucket.file('c6-aborted.bin').createWriteStream({ partSize: 1 })
      const writer = writable.getWriter()
      const reason = new Error('upload stopped')
      await writer.abort(reason)
      await expect(done).rejects.toBe(reason)
      await expect(writer.closed).rejects.toBe(reason)

      if (surface === 'writer') {
        await expect(writer.close()).rejects.toBeInstanceOf(TypeError)
      } else {
        writer.releaseLock()
        await expect(writable.close()).rejects.toBeInstanceOf(TypeError)
      }
    },
  )

  it('preserves the part-limit reason when close is queued with the oversized write', async () => {
    const { bucket } = await makeStreamClient(1)
    const { writable, done } = bucket.file('c6-queued-close.bin').createWriteStream({ partSize: 1 })
    const writer = writable.getWriter()
    const write = writer.write(deterministicBytes(10_001))
    const close = writer.close()
    const [writeResult, closeResult, doneResult] = await Promise.allSettled([write, close, done])
    expect(writeResult.status).toBe('rejected')
    if (writeResult.status !== 'rejected') throw new Error('oversized write unexpectedly succeeded')
    expect(writeResult.reason).toBeInstanceOf(RangeError)
    expect(writeResult.reason.message).toMatch(PART_LIMIT_MESSAGE)
    expect(closeResult).toEqual({ status: 'rejected', reason: writeResult.reason })
    expect(doneResult).toEqual({ status: 'rejected', reason: writeResult.reason })
  })

  it('still accepts a stream of exactly 10,000 parts', async () => {
    // Boundary control: an implementation that rejects every large stream must not pass.
    const payload = deterministicBytes(10_000)
    const { bucket, seen } = await makeStreamClient(1)
    const { writable, done } = bucket.file('c6-boundary.bin').createWriteStream({
      partSize: 1,
      concurrency: 4,
    })
    const writer = writable.getWriter()
    await writer.write(payload)
    await writer.close()
    await done

    const partNumbers = seen
      .filter((r) => r.url.includes('b2_upload_part'))
      .map((r) => Number(r.headers?.['X-Bz-Part-Number']))
    expect(Math.max(...partNumbers)).toBe(10_000)
    expect(new Set(partNumbers).size).toBe(10_000)
    const stored = await readStream((await bucket.file('c6-boundary.bin').download()).body)
    expect(stored).toEqual(payload)
  }, 60_000)
})
