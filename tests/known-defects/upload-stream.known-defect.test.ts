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

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const PART_LIMIT_MESSAGE = /10[,_ ]?000|too many parts|part.*limit/i
const SINGLE_PART_MESSAGE = /single[- ]part|one part|at least two parts|minimum part/i

/** Polls `predicate` until it holds or `timeoutMs` passes; resolves to whether it held. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleepMs(20)
  }
  return predicate()
}

describe('createWriteStream known defects', () => {
  it('a failed part rejects done and cancels the large file without close() or pipeTo', async () => {
    // The injected part failure is held behind a latch so the test can first observe
    // the unfinished large file, then release the fault and start its bounded waits.
    let releaseFault: () => void = () => {}
    const faultGate = new Promise<void>((resolve) => {
      releaseFault = resolve
    })
    let partRequestArrived: () => void = () => {}
    const partArrived = new Promise<void>((resolve) => {
      partRequestArrived = resolve
    })
    const { client, bucket, seen, completed } = await makeStreamClient(100_000, async (req) => {
      if (!req.url.includes('b2_upload_part')) return undefined
      partRequestArrived()
      await faultGate
      return jsonResp(400, { status: 400, code: 'bad_request', message: 'simulated part failure' })
    })
    const listUnfinished = () =>
      client.raw.listUnfinishedLargeFiles(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id },
      )
    const { writable, done } = bucket.file('c26.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 2,
    })
    const writer = writable.getWriter()
    try {
      // Hold the writer open after shipping one full part: no close(), no abort().
      const writeOutcome = writer.write(deterministicBytes(100_000)).then(
        () => undefined,
        (error: unknown) => error,
      )

      const arrived = await Promise.race([
        partArrived.then(() => true),
        sleepMs(5000).then(() => false),
      ])
      expect(arrived, 'the part upload request was never issued').toBe(true)
      const before = (await listUnfinished()).files.find((f) => f.fileName === 'c26.bin')
      expect(before, 'the large file must exist before the fault is released').toBeDefined()

      releaseFault()
      const settled = await Promise.race([
        done.then(
          () => ({ status: 'resolved' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        ),
        sleepMs(3000).then(() => ({ status: 'pending' as const })),
      ])
      expect(settled.status, 'done must reject once a part has failed').toBe('rejected')
      if (settled.status === 'rejected') {
        expect(settled.error).toBeInstanceOf(Error)
        expect((settled.error as { code?: string }).code).toBe('bad_request')
        expect((settled.error as Error).message).toMatch(/simulated part failure/)
      }
      const writeError = await writeOutcome
      if (writeError !== undefined)
        expect((writeError as Error).message).toMatch(/simulated part failure/)

      const cancelled = await waitFor(
        () => completed.some((u) => u.includes('b2_cancel_large_file')),
        3000,
      )
      expect(
        cancelled && seen.some((r) => r.url.includes('b2_cancel_large_file')),
        'b2_cancel_large_file was never sent and completed',
      ).toBe(true)
      const stillUnfinished = (await listUnfinished()).files.find(
        (f) => f.fileId === before?.fileId,
      )
      expect(
        stillUnfinished,
        'the failed large file was left unfinished instead of cancelled',
      ).toBeUndefined()
    } finally {
      releaseFault()
      await writer.abort().catch(() => undefined)
    }
  }, 20_000)

  it('data that fits in one part is not committed as a single-part large file', async () => {
    const payload = deterministicBytes(1_000)
    const { bucket, seen } = await makeStreamClient(100_000)
    const { writable, done } = bucket.file('c17.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    const writeOutcome = await writer.write(payload).then(
      () => undefined,
      (error: unknown) => error,
    )
    const closeOutcome = await writer.close().then(
      () => undefined,
      (error: unknown) => error,
    )
    const doneOutcome = await done.then(
      (file) => ({ file }),
      (error: unknown) => ({ error }),
    )

    // B2 requires at least two parts for a large file, so a one-part finish is never valid.
    const oneFinishedPart = seen
      .filter((r) => r.url.includes('b2_finish_large_file'))
      .map((r) => (JSON.parse(String(r.body)) as { partSha1Array: string[] }).partSha1Array.length)
      .filter((n) => n < 2)
    expect(oneFinishedPart, 'a large file was finished with fewer than two parts').toEqual([])

    if ('file' in doneOutcome) {
      // Accepted design 1: the single-request upload path stores exactly the written bytes.
      expect(writeOutcome).toBeUndefined()
      expect(closeOutcome).toBeUndefined()
      const stored = await readStream((await bucket.file('c17.bin').download()).body)
      expect(stored).toEqual(payload)
    } else {
      // Accepted design 2: rejecting the case, with an error that names the reason.
      expect(doneOutcome.error).toBeInstanceOf(Error)
      expect((doneOutcome.error as Error).message).toMatch(SINGLE_PART_MESSAGE)
    }
  })

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
