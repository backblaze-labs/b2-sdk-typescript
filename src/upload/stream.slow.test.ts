import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'

function makeClient(): { client: B2Client; sim: B2Simulator } {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.byteLength
  }
  return result
}

function deterministic(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

function chunkedReadable(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.byteLength)
      controller.enqueue(data.slice(offset, end))
      offset = end
    },
  })
}

describe('B2Object.createWriteStream', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'stream-upload', bucketType: 'allPrivate' })
  })

  it('pipes a chunked ReadableStream through createWriteStream and round-trips bytes', async () => {
    const total = 5_000_010
    const data = deterministic(total)
    const source = chunkedReadable(data, 128 * 1024)

    const { writable, done } = bucket.file('streamed.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 2,
    })

    await source.pipeTo(writable)
    const result = await done

    expect(result.fileName).toBe('streamed.bin')
    expect(result.contentLength).toBe(total)

    const dl = await bucket.download('streamed.bin')
    const got = await readStream(dl.body)
    expect(got).toEqual(data)
  })

  it('invokes the onProgress listener as parts complete', async () => {
    const data = deterministic(5_000_010)
    const events: { bytesTransferred: number; partsCompleted: number }[] = []
    const { writable, done } = bucket.file('progress.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
      onProgress: (e) => {
        events.push({ bytesTransferred: e.bytesTransferred, partsCompleted: e.partsCompleted })
      },
    })

    await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    await done

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.bytesTransferred).toBe(data.byteLength)
    expect(last?.partsCompleted).toBe(2)
  })

  it('rejects when the writable is closed without any data', async () => {
    const { writable, done } = bucket.file('empty.bin').createWriteStream({
      partSize: 5_000_000,
    })

    const writer = writable.getWriter()
    // Both the writer.close() promise and the `done` promise reject. Attach a
    // handler to both to avoid unhandled rejection noise.
    const closePromise = writer.close().catch(() => {})
    await closePromise
    await expect(done).rejects.toThrow(/without any data/)
  })

  it('abort cancels the unfinished large file and rejects done', async () => {
    const controller = new AbortController()
    const { writable, done } = bucket.file('aborted.bin').createWriteStream({
      partSize: 5_000_000,
      signal: controller.signal,
    })

    // Pump a tiny bit of data, then abort before close.
    const writer = writable.getWriter()
    await writer.write(new Uint8Array(100))
    controller.abort()
    try {
      await writer.close()
    } catch {
      // expected
    }
    await expect(done).rejects.toBeDefined()

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    // The large file may or may not have been started before abort fired;
    // either way it should not remain unfinished.
    expect(unfinished.files.find((f) => f.fileName === 'aborted.bin')).toBeUndefined()
  })

  it('merges multiple buffered chunks into a single final part at close', async () => {
    // Each write is smaller than partSize, so the write() loop never
    // dispatches a part. close() then has to flush a pending queue with
    // length > 1, exercising the multi-chunk merge branch in dispatchPart.
    const partSize = 5_000_000
    const chunkA = deterministic(1_000)
    const chunkB = deterministic(2_000)
    const chunkC = deterministic(3_000)

    const { writable, done } = bucket.file('merged.bin').createWriteStream({
      partSize,
      concurrency: 1,
    })

    const writer = writable.getWriter()
    await writer.write(chunkA)
    await writer.write(chunkB)
    await writer.write(chunkC)
    await writer.close()
    const result = await done

    expect(result.fileName).toBe('merged.bin')
    expect(result.contentLength).toBe(6_000)

    const dl = await bucket.download('merged.bin')
    const got = await readStream(dl.body)
    const expected = new Uint8Array(6_000)
    expected.set(chunkA, 0)
    expected.set(chunkB, 1_000)
    expected.set(chunkC, 3_000)
    expect(got).toEqual(expected)
  })

  it('closes cleanly when total bytes are an exact partSize multiple (no remainder)', async () => {
    // Write 2 * partSize so the inner write() loop ships both parts and
    // close() sees pendingBytes === 0 (the "skip dispatchPart" branch).
    const partSize = 5_000_000
    const data = deterministic(partSize * 2)

    const { writable, done } = bucket.file('exact.bin').createWriteStream({
      partSize,
      concurrency: 2,
    })

    await chunkedReadable(data, 256 * 1024).pipeTo(writable)
    const result = await done

    expect(result.contentLength).toBe(partSize * 2)
    const dl = await bucket.download('exact.bin')
    const got = await readStream(dl.body)
    expect(got.byteLength).toBe(partSize * 2)
    expect(got).toEqual(data)
  })

  it('clamps a too-small partSize up to the account minimum and still round-trips', async () => {
    // partSize=1000 is well below the simulator's 5_000_000 minimum. The
    // implementation must raise it; otherwise the simulator rejects the
    // small parts and the test would fail.
    const data = deterministic(5_000_010)

    const { writable, done } = bucket.file('clamped.bin').createWriteStream({
      partSize: 1_000,
      concurrency: 1,
    })

    await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    const result = await done

    expect(result.contentLength).toBe(5_000_010)
    const dl = await bucket.download('clamped.bin')
    const got = await readStream(dl.body)
    expect(got).toEqual(data)
  })

  it('rejects done and cancels the unfinished large file when b2_upload_part fails', async () => {
    // Wrap the simulator transport so b2_upload_part always returns a
    // non-retryable 400 bad_request. The streaming engine's `errored` latch
    // should fire, close() should cancel the started large file, and done
    // should reject. The bucket must end up with no orphan unfinished file.
    const sim = new B2Simulator()
    const inner = sim.transport()
    const failing: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          const errorBody = JSON.stringify({
            status: 400,
            code: 'bad_request',
            message: 'simulated part failure',
          })
          return {
            status: 400,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(errorBody))
                controller.close()
              },
            }),
            json: <T>() => Promise.resolve(JSON.parse(errorBody) as T),
            text: () => Promise.resolve(errorBody),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(errorBody).buffer as ArrayBuffer),
          }
        }
        return inner.send(req)
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: failing,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'fail-stream',
      bucketType: 'allPrivate',
    })

    const data = deterministic(5_000_010)
    const { writable, done } = failBucket.file('boom.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
    })

    let pipeError: unknown
    try {
      await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    } catch (err) {
      pipeError = err
    }
    expect(pipeError).toBeDefined()
    await expect(done).rejects.toBeDefined()

    // The engine must have cleaned up the unfinished large file via
    // cancelLargeFile in the close() catch path.
    const unfinished = await failClient.raw.listUnfinishedLargeFiles(
      failClient.accountInfo.getApiUrl(),
      failClient.accountInfo.getAuthToken(),
      { bucketId: failBucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'boom.bin')).toBeUndefined()
  })

  it('abort after parts have started cancels the unfinished large file', async () => {
    // Stream enough bytes that the engine has called startLargeFile and
    // dispatched at least one in-flight part, then abort. The abort()
    // hook in the WritableStream sink must hit the largeFileId !== null
    // branch and call cancelLargeFile.
    const controller = new AbortController()
    const { writable, done } = bucket.file('abort-mid.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
      signal: controller.signal,
    })

    const writer = writable.getWriter()
    // First write ships a part (5MB), forcing startLargeFile.
    await writer.write(deterministic(5_000_000))
    // Give the engine a tick so startLargeFile resolves and largeFileId
    // becomes non-null before we abort.
    await new Promise((r) => setTimeout(r, 50))

    await writer.abort(new Error('user aborted'))
    controller.abort()
    await expect(done).rejects.toBeDefined()

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'abort-mid.bin')).toBeUndefined()
  })

  it('honors a slow-consumer pipeTo (backpressure via concurrency=1) and round-trips bytes', async () => {
    // Pipe a chunked source through createWriteStream with concurrency=1.
    // The semaphore in the engine serialises part uploads, so the second
    // part has to wait on the semaphore's release, exercising the queue
    // throttling path. The pull() in the source is intentionally async so
    // the WritableStream backpressure protocol is exercised.
    const partSize = 5_000_000
    const total = partSize * 2 + 123
    const data = deterministic(total)

    let offset = 0
    const slowSource = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Yield to the event loop on every pull so the writer has a chance
        // to apply backpressure between chunks.
        await new Promise((r) => setTimeout(r, 0))
        if (offset >= data.byteLength) {
          controller.close()
          return
        }
        const end = Math.min(offset + 64 * 1024, data.byteLength)
        controller.enqueue(data.slice(offset, end))
        offset = end
      },
    })

    const { writable, done } = bucket.file('slow.bin').createWriteStream({
      partSize,
      concurrency: 1,
    })

    await slowSource.pipeTo(writable)
    const result = await done

    expect(result.contentLength).toBe(total)
    const dl = await bucket.download('slow.bin')
    const got = await readStream(dl.body)
    expect(got).toEqual(data)
  })

  it('passes serverSideEncryption through to startLargeFile and each part upload', async () => {
    // Exercises the SSE conditional-spread branches in both startLargeFile
    // and the per-part uploadPart call. The simulator accepts SSE-B2
    // without further setup.
    const data = deterministic(5_000_010)
    const { writable, done } = bucket.file('sse-stream.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
      serverSideEncryption: { mode: 'SSE-B2', algorithm: 'AES256' },
    })

    await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    const result = await done

    expect(result.fileName).toBe('sse-stream.bin')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('swallows cancelLargeFile failures during close-path cleanup', async () => {
    // After a part upload fails, the close-path catch invokes
    // cancelLargeFile as best-effort cleanup. Inject a failure on
    // b2_cancel_large_file too; the engine should swallow it and still
    // reject done with the original error.
    const sim = new B2Simulator()
    const inner = sim.transport()
    const failing: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const failingPaths = ['b2_upload_part', 'b2_cancel_large_file']
        if (failingPaths.some((p) => req.url.includes(p))) {
          const errorBody = JSON.stringify({
            status: 400,
            code: 'bad_request',
            message: 'simulated failure',
          })
          return {
            status: 400,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(errorBody))
                controller.close()
              },
            }),
            json: <T>() => Promise.resolve(JSON.parse(errorBody) as T),
            text: () => Promise.resolve(errorBody),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(errorBody).buffer as ArrayBuffer),
          }
        }
        return inner.send(req)
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: failing,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'cleanup-fail',
      bucketType: 'allPrivate',
    })

    const data = deterministic(5_000_010)
    const { writable, done } = failBucket.file('cleanup-boom.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
    })

    let pipeError: unknown
    try {
      await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    } catch (err) {
      pipeError = err
    }
    expect(pipeError).toBeDefined()
    await expect(done).rejects.toBeDefined()
  })

  it('swallows cancelLargeFile failures during the abort hook', async () => {
    // Start a large file by writing a full part, then abort the writer.
    // Make cancelLargeFile fail; the abort() hook should swallow the
    // cleanup error and still reject done with the abort reason.
    const sim = new B2Simulator()
    const inner = sim.transport()
    const failing: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_cancel_large_file')) {
          const errorBody = JSON.stringify({
            status: 400,
            code: 'bad_request',
            message: 'simulated cancel failure',
          })
          return {
            status: 400,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(errorBody))
                controller.close()
              },
            }),
            json: <T>() => Promise.resolve(JSON.parse(errorBody) as T),
            text: () => Promise.resolve(errorBody),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(errorBody).buffer as ArrayBuffer),
          }
        }
        return inner.send(req)
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: failing,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'abort-cancel-fail',
      bucketType: 'allPrivate',
    })

    const { writable, done } = failBucket.file('abort-cancel.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
    })

    const writer = writable.getWriter()
    // Ship one full part so startLargeFile resolves and largeFileId is set.
    await writer.write(deterministic(5_000_000))
    // Wait so the in-flight part finishes and largeFileId is populated.
    await new Promise((r) => setTimeout(r, 200))

    await writer.abort(new Error('boom'))
    await expect(done).rejects.toBeDefined()
  })

  it('close() rethrows the errored latch and cancels the unfinished large file', async () => {
    // Write a chunk that triggers a part upload, wait for the part to
    // fail asynchronously (so `errored` is latched), then close() the
    // writer directly. close() must hit its `if (errored) throw errored`
    // guard, cancel the started large file, and reject done.
    const sim = new B2Simulator()
    const inner = sim.transport()
    const failing: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          const errorBody = JSON.stringify({
            status: 400,
            code: 'bad_request',
            message: 'simulated part failure',
          })
          return {
            status: 400,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(errorBody))
                controller.close()
              },
            }),
            json: <T>() => Promise.resolve(JSON.parse(errorBody) as T),
            text: () => Promise.resolve(errorBody),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(errorBody).buffer as ArrayBuffer),
          }
        }
        return inner.send(req)
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: failing,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'close-errored',
      bucketType: 'allPrivate',
    })

    const { writable, done } = failBucket.file('close-errored.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
    })

    const writer = writable.getWriter()
    // Ship one full part. The task fires-and-forgets; write() returns.
    await writer.write(deterministic(5_000_000))
    // Give the in-flight task time to fail and latch `errored`.
    await new Promise((r) => setTimeout(r, 300))

    let closeErr: unknown
    try {
      await writer.close()
    } catch (err) {
      closeErr = err
    }
    expect(closeErr).toBeDefined()
    await expect(done).rejects.toBeDefined()

    const unfinished = await failClient.raw.listUnfinishedLargeFiles(
      failClient.accountInfo.getApiUrl(),
      failClient.accountInfo.getAuthToken(),
      { bucketId: failBucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'close-errored.bin')).toBeUndefined()
  })
})
