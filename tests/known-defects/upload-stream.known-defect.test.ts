// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { deterministicBytes } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

function jsonResp(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

async function makeStreamClient(
  minimumPartSize: number,
  intercept: (req: HttpRequest) => HttpResponse | undefined,
) {
  const sim = new B2Simulator({ minimumPartSize })
  const inner = sim.transport()
  const seen: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req)
      return intercept(req) ?? inner.send(req)
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
  return { client, bucket, sim, seen }
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('createWriteStream known defects', () => {
  it('a failed part rejects done and cancels the large file without close() or pipeTo', async () => {
    const { client, bucket } = await makeStreamClient(100_000, (req) =>
      req.url.includes('b2_upload_part')
        ? jsonResp(400, { status: 400, code: 'bad_request', message: 'simulated part failure' })
        : undefined,
    )
    const { writable, done } = bucket.file('c26.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 2,
    })
    const writer = writable.getWriter()
    // Hold the writer open after shipping one full part: no close(), no abort().
    void writer.write(deterministicBytes(100_000)).catch(() => undefined)

    const settled = await Promise.race([
      done.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      sleepMs(1500).then(() => 'pending' as const),
    ])
    expect(settled, 'done must reject once a part has failed').toBe('rejected')

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(
      unfinished.files.find((f) => f.fileName === 'c26.bin'),
      'the failed large file was left unfinished instead of cancelled',
    ).toBeUndefined()
  })

  it('data that fits in one part is not committed as a single-part large file', async () => {
    const { seen } = await (async () => {
      const ctx = await makeStreamClient(100_000, () => undefined)
      const { writable, done } = ctx.bucket.file('c17.bin').createWriteStream({
        partSize: 100_000,
        concurrency: 1,
      })
      const writer = writable.getWriter()
      await writer.write(deterministicBytes(1_000))
      await writer.close().catch(() => undefined)
      await done.catch(() => undefined)
      return ctx
    })()

    const finishes = seen.filter((r) => r.url.includes('b2_finish_large_file'))
    for (const req of finishes) {
      const body = JSON.parse(String(req.body)) as { partSha1Array: string[] }
      // B2 requires at least two parts for a large file; the SDK must use the
      // single-request upload path (or reject) instead of finishing one part.
      expect(
        body.partSha1Array.length,
        'a large file was finished with fewer than two parts',
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('never ships part number 10,001', async () => {
    const { bucket, seen } = await makeStreamClient(1, () => undefined)
    const { writable, done } = bucket.file('c6.bin').createWriteStream({
      partSize: 1,
      concurrency: 4,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(10_001)).catch(() => undefined)
    await writer.close().catch(() => undefined)
    await done.catch(() => undefined)

    const partNumbers = seen
      .filter((r) => r.url.includes('b2_upload_part'))
      .map((r) => Number(r.headers?.['X-Bz-Part-Number']))
    expect(
      Math.max(0, ...partNumbers),
      'a part number above 10,000 was uploaded',
    ).toBeLessThanOrEqual(10_000)
  }, 60_000)
})
