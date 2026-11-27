import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { deterministicBytes, readStream } from '../test-utils/index.ts'
import { resetRemoteSimulator } from '../test-utils/remote-simulator.ts'
import { BucketType } from '../types/bucket.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'
import type { CleanupFailureEvent } from './cancel.ts'

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

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

describe('createWriteStream regressions', () => {
  it('Finding C26: a failed part rejects done and cancels the large file without close() or pipeTo', async () => {
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

  it('Finding C17: data that fits in one part is not committed as a single-part large file', async () => {
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

  it.each([99_999, 100_000, 100_001])(
    'preserves content, metadata, and progress around the one-part boundary (%i bytes)',
    async (size) => {
      const payload = deterministicBytes(size)
      const { bucket, seen } = await makeStreamClient(100_000)
      const progress: number[] = []
      const { writable, done } = bucket.file('boundary.bin').createWriteStream({
        partSize: 100_000,
        concurrency: 1,
        contentType: 'application/octet-stream',
        fileInfo: { purpose: 'boundary' },
        onProgress: (event) => {
          expect(event.totalBytes).toBeNull()
          progress.push(event.bytesTransferred)
        },
      })
      const writer = writable.getWriter()
      await writer.write(payload.subarray(0, 60_000))
      await writer.write(payload.subarray(60_000))
      await writer.close()
      const file = await done

      expect(file.contentLength).toBe(size)
      expect(file.contentType).toBe('application/octet-stream')
      expect(file.fileInfo).toMatchObject({ purpose: 'boundary' })
      expect(await readStream((await bucket.file('boundary.bin').download()).body)).toEqual(payload)
      expect(progress.at(-1)).toBe(size)
      expect(progress.every((bytes) => bytes <= size)).toBe(true)
      expect(seen.filter((req) => req.url.includes('b2_upload_file'))).toHaveLength(
        size <= 100_000 ? 1 : 0,
      )
      expect(seen.filter((req) => req.url.includes('b2_finish_large_file'))).toHaveLength(
        size > 100_000 ? 1 : 0,
      )
      expect(seen.filter((req) => req.url.includes('b2_cancel_large_file'))).toHaveLength(
        size === 100_000 ? 1 : 0,
      )
    },
  )

  it.each([1_000, 100_000, 200_000])(
    'ignores non-streaming options on a reused options object (%i bytes)',
    async (size) => {
      const { client, seen } = await makeStreamClient(100_000)
      const bucket = await client.createBucket({
        bucketName: 'stream-options-contract',
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
      })
      // Structural typing allows a variable with additional upload options.
      // Those fields must not silently take effect only on the small-file path.
      const options = {
        partSize: 100_000,
        fileInfo: { purpose: 'stream-options' },
        fileRetention: {
          mode: RetentionMode.Compliance,
          retainUntilTimestamp: Date.UTC(2100, 0, 1),
        },
        legalHold: LegalHoldValue.On,
        lastModifiedMillis: 1_700_000_000_000,
      }
      const object = bucket.file('reused-options.bin')
      const { writable, done } = object.createWriteStream(options)
      const writer = writable.getWriter()
      const payload = deterministicBytes(size)
      await writer.write(payload)
      await writer.close()
      const uploaded = await done
      const stored = await object.getFileInfo(uploaded.fileId)

      // The simulator does not persist upload-file Object Lock headers, so
      // check the HTTP boundary as well as the stored metadata.
      const singleUploads = seen.filter((req) => req.url.includes('b2_upload_file'))
      expect(singleUploads).toHaveLength(size <= 100_000 ? 1 : 0)
      for (const req of singleUploads) {
        const headers = new Headers(req.headers)
        expect({
          retentionMode: headers.get('X-Bz-File-Retention-Mode'),
          retainUntil: headers.get('X-Bz-File-Retention-Retain-Until-Timestamp'),
          legalHold: headers.get('X-Bz-File-Legal-Hold'),
        }).toEqual({ retentionMode: null, retainUntil: null, legalHold: null })
      }
      expect(stored.fileRetention).toEqual({ isClientAuthorizedToRead: true, value: null })
      expect(stored.legalHold).toEqual({ isClientAuthorizedToRead: true, value: null })
      expect(stored.fileInfo).toEqual({ purpose: 'stream-options' })
      expect(await readStream((await object.download()).body)).toEqual(payload)
    },
  )

  it('preserves the part error and reports one failed cancellation without requiring close', async () => {
    const cleanupFailures: CleanupFailureEvent[] = []
    const { bucket, seen } = await makeStreamClient(100_000, (req) => {
      if (req.url.includes('b2_upload_part')) {
        return jsonResp(400, { status: 400, code: 'bad_request', message: 'original part error' })
      }
      if (req.url.includes('b2_cancel_large_file')) {
        return jsonResp(400, { status: 400, code: 'bad_request', message: 'cancel error' })
      }
      return undefined
    })
    const { writable, done } = bucket.file('failed-cleanup.bin').createWriteStream({
      partSize: 100_000,
      onCleanupFailure: (event) => cleanupFailures.push(event),
    })
    const writer = writable.getWriter()
    const closedOutcome = writer.closed.catch((error: unknown) => error)
    await writer.write(deterministicBytes(100_000)).catch(() => undefined)
    await expect(done).rejects.toThrow('original part error')
    const error = await closedOutcome
    await expect(done).rejects.toBe(error)
    await expect(writer.write(deterministicBytes(1))).rejects.toBe(error)
    expect(cleanupFailures).toHaveLength(1)
    expect(cleanupFailures[0]).toMatchObject({ reason: 'cancel-failed' })
    expect(seen.filter((req) => req.url.includes('b2_cancel_large_file'))).toHaveLength(1)
  })
})
