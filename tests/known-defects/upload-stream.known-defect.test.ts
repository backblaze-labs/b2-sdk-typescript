// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { deterministicBytes, readStream } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

type Intercept = (req: HttpRequest) => Promise<HttpResponse | undefined> | HttpResponse | undefined

async function makeStreamClient(minimumPartSize: number, intercept: Intercept = () => undefined) {
  const sim = new B2Simulator({ minimumPartSize })
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

describe('createWriteStream known defects', () => {
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
    expect(doneOutcome, 'done must reject an oversized stream').toBeInstanceOf(Error)
    expect((doneOutcome as Error).message).toMatch(PART_LIMIT_MESSAGE)
    for (const outcome of [writeOutcome, closeOutcome]) {
      if (outcome !== undefined) expect((outcome as Error).message).toMatch(PART_LIMIT_MESSAGE)
    }
    const partNumbers = seen
      .filter((r) => r.url.includes('b2_upload_part'))
      .map((r) => Number(r.headers?.['X-Bz-Part-Number']))
    expect(
      Math.max(0, ...partNumbers),
      'a part number above 10,000 was uploaded',
    ).toBeLessThanOrEqual(10_000)
  }, 60_000)

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
