import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import { FinishLargeFileResponseBodyError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { deferred, deterministicBytes, makeClient } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

/**
 * Branch-coverage tests for `createWriteStream` in `upload/stream.ts`. The
 * happy-path multipart tests live in `stream.slow.test.ts`; this file
 * targets the remaining branches that aren't on a typical success path:
 *
 *   - `partSize ?? recommendedPartSize` default: exercised by
 *     omitting `partSize` so the engine falls back to the account's
 *     advertised recommended size. Uses a small simulator recommendation
 *     so the test still finishes near-instantly.
 *   - `errored = err instanceof Error ? err : new Error(String(err))`
 *     path: exercised by injecting a non-`Error` throw
 *     from `b2_upload_part`.
 *   - `write()`'s "if (errored) throw errored" guard: exercised
 *     by writing another chunk after the first part has already errored.
 *   - `abort()`'s "reason instanceof Error" branch: exercised
 *     by aborting the writer with a non-Error reason (a plain string).
 *
 * Uses a `minimumPartSize: 100_000` + `recommendedPartSize: 200_000`
 * simulator so the slow multipart paths fit comfortably in the fast tier.
 */

describe('createWriteStream branch coverage', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 200_000 }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'stream-cov',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('falls back to recommendedPartSize when partSize is omitted', async () => {
    // No `partSize` in the call: the engine picks the simulator's advertised
    // recommendedPartSize (200_000 here) and runs the upload through that.
    const data = deterministicBytes(400_000) // 2 parts at 200_000 each

    const { writable, done } = bucket.file('no-part-size.bin').createWriteStream({
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(data)
    await writer.close()
    const result = await done

    expect(result.fileName).toBe('no-part-size.bin')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('applies backpressure instead of queueing stalled part buffers', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let uploadStarts = 0
    const uploadStartWaiters: Array<() => void> = []
    const uploadReleases: Array<() => void> = []
    const waitForUploadStart = async (count: number): Promise<void> => {
      if (uploadStarts >= count) return
      await new Promise<void>((resolve) => {
        uploadStartWaiters.push(() => {
          if (uploadStarts >= count) resolve()
        })
      })
    }
    const stalledTransport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          uploadStarts++
          for (const waiter of uploadStartWaiters.splice(0)) waiter()
          await new Promise<void>((resolve) => uploadReleases.push(resolve))
        }
        return inner.send(req)
      },
    }
    const stallClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: stalledTransport,
      retry: { maxRetries: 0 },
    })
    await stallClient.authorize()
    const stallBucket = await stallClient.createBucket({
      bucketName: 'stream-backpressure',
      bucketType: BucketType.AllPrivate,
    })
    const { writable, done } = stallBucket.file('backpressure.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()

    await writer.write(deterministicBytes(100_000))
    await waitForUploadStart(1)

    let secondWriteSettled = false
    const secondWrite = writer.write(deterministicBytes(100_000)).then(() => {
      secondWriteSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondWriteSettled).toBe(false)

    uploadReleases.shift()?.()
    await secondWrite
    await waitForUploadStart(2)
    uploadReleases.shift()?.()
    await writer.close()
    const result = await done

    expect(result.fileName).toBe('backpressure.bin')
    expect(result.contentLength).toBe(200_000)
  })

  it('wraps a non-Error throw from uploadPart so done rejects with an Error', async () => {
    // Custom transport rejects b2_upload_part with a plain string (not an
    // Error instance). The engine's `errored` latch must wrap it via
    // `new Error(String(err))` rather than passing it through unchanged,
    // so `done` ultimately rejects with an actual Error subclass.
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 200_000 })
    const inner = sim.transport()
    const failing: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          // Throw a non-Error value to exercise the `instanceof Error` false branch.
          throw 'plain-string-upload-failure'
        }
        return inner.send(req)
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: failing,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'string-err',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = failBucket.file('string-err.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    // pipeTo + a single-part chunk: the chunk dispatches, the part fails
    // with a non-Error throw, and pipeTo surfaces the rejection. We don't
    // need to call writer.write() twice — exercising the dispatch + the
    // `errored = err instanceof Error ? ... : new Error(String(err))` path
    // requires only one failing part.
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100_000))
        controller.close()
      },
    })
    await expect(reader.pipeTo(writable)).rejects.toBeDefined()
    // Observe `done` only after pipeTo has already rejected it. This is the
    // real-world consumer ordering, and it works without tripping an
    // unhandled rejection because the engine attaches an internal no-op
    // `done.catch` (see src/upload/stream.ts). Under Bun / Node strict mode
    // this would otherwise fail.
    const rejection = await done.then(
      () => null,
      (err) => err,
    )
    // `done`'s rejection must be an Error subclass even though the underlying
    // throw was a plain string.
    expect(rejection).toBeInstanceOf(Error)
  })

  // Note: `if (errored) throw errored` inside write() is reachable
  // in theory but hard to exercise reliably from a test. The WritableStream
  // pipeTo machinery either: (a) aborts after the first sink.write() resolves
  // and the abort hook tears down before the next write, or (b) races the
  // background part-upload task such that `errored` isn't latched yet when
  // the second sink.write() runs. Leaving this branch uncovered rather than
  // shipping a flaky test that depends on event-loop micro-timings.

  it('abort() wraps a non-Error reason in an Error', async () => {
    // The abort() hook is invoked with `reason` of arbitrary type. When the
    // caller passes a string, the engine must wrap it as `new Error(String(reason))`
    // before calling `rejectDone` so the `done` promise rejects with an
    // Error subclass.
    const { writable, done } = bucket.file('abort-string.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    // Push a tiny bit of data so the engine has called startLargeFile and
    // largeFileId is non-null (covers the `if (largeFileId !== null)` branch
    // in abort).
    await writer.write(new Uint8Array(100_000))
    await new Promise((r) => setTimeout(r, 50))

    await writer.abort('user-cancelled-as-string')

    const rejection = await done.then(
      () => null,
      (err) => err,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection.message).toContain('user-cancelled-as-string')
  })

  it('cancels a multipart file when aborted while startLargeFile is in flight', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let startSeen!: () => void
    let releaseStart!: () => void
    const startSeenPromise = new Promise<void>((resolve) => {
      startSeen = resolve
    })
    const releaseStartPromise = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    let cancelCalls = 0
    let uploadPartCalls = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_start_large_file')) {
          startSeen()
          await releaseStartPromise
        }
        if (req.url.includes('b2_upload_part?')) {
          uploadPartCalls++
        }
        if (req.url.includes('b2_cancel_large_file')) {
          cancelCalls++
        }
        return inner.send(req)
      },
    }
    const raceClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await raceClient.authorize()
    const raceBucket = await raceClient.createBucket({
      bucketName: 'abort-start-race',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = raceBucket.file('abort-start-race.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await startSeenPromise

    const abortPromise = writer.abort(new Error('abort while starting'))
    const abortResult = await Promise.race([
      abortPromise.then(() => 'aborted' as const),
      delay(1_000).then(() => 'timed-out' as const),
    ])
    expect(abortResult).toBe('aborted')
    releaseStart()
    await abortPromise
    await expect(done).rejects.toThrow('abort while starting')

    for (let attempt = 0; attempt < 100 && cancelCalls === 0; attempt++) {
      await delay(20)
    }
    expect(cancelCalls).toBe(1)
    expect(uploadPartCalls).toBe(0)
    const unfinished = await raceClient.raw.listUnfinishedLargeFiles(
      raceClient.accountInfo.getApiUrl(),
      raceClient.accountInfo.getAuthToken(),
      { bucketId: raceBucket.id },
    )
    expect(
      unfinished.files.find((file) => file.fileName === 'abort-start-race.bin'),
    ).toBeUndefined()
  })

  it('passes the abort signal to stalled startLargeFile requests', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let startSeen!: () => void
    const startSeenPromise = new Promise<void>((resolve) => {
      startSeen = resolve
    })
    let startSignal: AbortSignal | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_start_large_file')) {
          startSignal = req.signal
          startSeen()
          return rejectOnAbort(req.signal, 'stream start aborted')
        }
        return inner.send(req)
      },
    }
    const startClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await startClient.authorize()
    const startBucket = await startClient.createBucket({
      bucketName: 'stream-start-signal',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = startBucket.file('stream-start-signal.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await startSeenPromise

    await writer.abort(new Error('stream start aborted'))
    expect(startSignal?.aborted).toBe(true)
    await expect(done).rejects.toThrow('stream start aborted')
  })

  it('passes abort signal to stalled finish and uses independent cleanup signal', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    const controller = new AbortController()
    let finishSeen!: () => void
    const finishSeenPromise = new Promise<void>((resolve) => {
      finishSeen = resolve
    })
    let finishSignal: AbortSignal | undefined
    let cancelSignal: AbortSignal | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_finish_large_file')) {
          finishSignal = req.signal
          finishSeen()
          return rejectOnAbort(req.signal, 'stream finish aborted')
        }
        if (req.url.includes('b2_cancel_large_file')) {
          cancelSignal = req.signal
          return inner.send(req)
        }
        return inner.send(req)
      },
    }
    const finishClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await finishClient.authorize()
    const finishBucket = await finishClient.createBucket({
      bucketName: 'stream-finish-signal',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = finishBucket.file('stream-finish-signal.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
      signal: controller.signal,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await writer.write(deterministicBytes(100_000))
    const closePromise = writer.close()
    await finishSeenPromise
    controller.abort(new Error('stream finish aborted'))

    await expect(closePromise).rejects.toThrow('stream finish aborted')
    await expect(done).rejects.toThrow('stream finish aborted')
    expect(finishSignal?.aborted).toBe(true)
    expect(cancelSignal?.aborted).toBe(false)
  })

  it('aborts an in-flight write-stream part request when the writer aborts', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let uploadSeen!: () => void
    const uploadSeenPromise = new Promise<void>((resolve) => {
      uploadSeen = resolve
    })
    let observedSignal: AbortSignal | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part?')) {
          observedSignal = req.signal
          uploadSeen()
          return new Promise<HttpResponse>((_resolve, reject) => {
            const rejectWithAbort = () => reject(req.signal?.reason ?? new Error('part aborted'))
            if (req.signal?.aborted === true) {
              rejectWithAbort()
            } else {
              req.signal?.addEventListener('abort', rejectWithAbort, { once: true })
            }
          })
        }
        return inner.send(req)
      },
    }
    const abortClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await abortClient.authorize()
    const abortBucket = await abortClient.createBucket({
      bucketName: 'abort-inflight',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = abortBucket.file('abort-inflight.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await uploadSeenPromise

    await writer.abort(new Error('stop in-flight part'))
    expect(observedSignal?.aborted).toBe(true)
    await expect(done).rejects.toThrow('stop in-flight part')
  })

  it('waits for in-flight write-stream parts before cancelling on abort', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let uploadSeen!: () => void
    const uploadSeenPromise = new Promise<void>((resolve) => {
      uploadSeen = resolve
    })
    let releasePart!: () => void
    const releasePartPromise = new Promise<void>((resolve) => {
      releasePart = resolve
    })
    const events: string[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part?')) {
          uploadSeen()
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              events.push('part-aborted')
              resolve()
            }
            if (req.signal?.aborted === true) {
              onAbort()
            } else {
              req.signal?.addEventListener('abort', onAbort, { once: true })
            }
          })
          await releasePartPromise
          events.push('part-settled')
          throw req.signal?.reason ?? new Error('part aborted')
        }
        if (req.url.includes('b2_cancel_large_file')) {
          events.push('cancel')
        }
        return inner.send(req)
      },
    }
    const abortClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await abortClient.authorize()
    const abortBucket = await abortClient.createBucket({
      bucketName: 'abort-drain',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = abortBucket.file('abort-drain.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await uploadSeenPromise

    const abortPromise = writer.abort(new Error('drain before cancel'))
    await delay(20)
    expect(events).toEqual(['part-aborted'])
    releasePart()
    await abortPromise

    await expect(done).rejects.toThrow('drain before cancel')
    expect(events).toEqual(['part-aborted', 'part-settled', 'cancel'])
  })

  it('does not wait for cleanup when an in-flight start later fails', async () => {
    const startCalled = deferred<void>()
    const releaseStart = deferred<void>()
    vi.spyOn(client.raw, 'startLargeFile').mockImplementation(async () => {
      startCalled.resolve(undefined)
      await releaseStart.promise
      throw new Error('start failed')
    })
    const cancelLargeFile = vi.spyOn(client.raw, 'cancelLargeFile')

    const { writable, done } = bucket.file('abort-start-fails.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(new Uint8Array(100_000))
    await startCalled.promise

    const abortPromise = writer.abort(new Error('abort while start fails'))
    const abortResult = await Promise.race([
      abortPromise.then(() => 'aborted' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
    ])
    expect(abortResult).toBe('aborted')
    await expect(done).rejects.toThrow('abort while start fails')

    releaseStart.resolve(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(cancelLargeFile).not.toHaveBeenCalled()
  })

  it('applies write backpressure before buffering another full part', async () => {
    const firstUploadStarted = deferred<void>()
    const releaseFirstUpload = deferred<void>()
    const originalUploadPart = client.raw.uploadPart.bind(client.raw)
    const uploadPart = vi.spyOn(client.raw, 'uploadPart').mockImplementation(async (...args) => {
      if (uploadPart.mock.calls.length === 1) {
        firstUploadStarted.resolve(undefined)
        await releaseFirstUpload.promise
      }
      return originalUploadPart(...args)
    })

    const { writable, done } = bucket.file('backpressure.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    await firstUploadStarted.promise

    let secondWriteResolved = false
    const secondWrite = writer.write(deterministicBytes(100_000)).then(() => {
      secondWriteResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(secondWriteResolved).toBe(false)
    expect(uploadPart).toHaveBeenCalledTimes(1)

    releaseFirstUpload.resolve(undefined)
    await secondWrite
    await writer.close()
    await done
    expect(uploadPart).toHaveBeenCalledTimes(2)
  })

  it('ignores empty write chunks before buffering upload data', async () => {
    const startLargeFile = vi.spyOn(client.raw, 'startLargeFile')
    const uploadPart = vi.spyOn(client.raw, 'uploadPart')

    const { writable, done } = bucket.file('empty-writes.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    for (let i = 0; i < 1_000; i += 1) {
      await writer.write(new Uint8Array(0))
    }

    expect(startLargeFile).not.toHaveBeenCalled()
    expect(uploadPart).not.toHaveBeenCalled()

    await writer.write(deterministicBytes(100_000))
    await writer.close()
    await done

    expect(startLargeFile).toHaveBeenCalledTimes(1)
    expect(uploadPart).toHaveBeenCalledTimes(1)
  })

  it('waits for pending part uploads before cleanup after a part failure', async () => {
    const secondUploadStarted = deferred<void>()
    const releaseSecondUpload = deferred<void>()
    const originalUploadPart = client.raw.uploadPart.bind(client.raw)
    const originalCancelLargeFile = client.raw.cancelLargeFile.bind(client.raw)
    let secondUploadSettled = false
    const uploadPart = vi.spyOn(client.raw, 'uploadPart').mockImplementation(async (...args) => {
      const callNumber = uploadPart.mock.calls.length
      if (callNumber === 1) {
        await secondUploadStarted.promise
        throw new Error('forced first part failure')
      }
      if (callNumber === 2) {
        secondUploadStarted.resolve(undefined)
        await releaseSecondUpload.promise
        const response = await originalUploadPart(...args)
        secondUploadSettled = true
        return response
      }
      return originalUploadPart(...args)
    })
    const cancelLargeFile = vi
      .spyOn(client.raw, 'cancelLargeFile')
      .mockImplementation(async (...args) => {
        expect(secondUploadSettled).toBe(true)
        return originalCancelLargeFile(...args)
      })

    const { writable, done } = bucket.file('settle-before-cleanup.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 2,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(200_000))

    const close = writer.close()
    await secondUploadStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cancelLargeFile).not.toHaveBeenCalled()

    releaseSecondUpload.resolve(undefined)
    await expect(close).rejects.toThrow('forced first part failure')
    await expect(done).rejects.toThrow('forced first part failure')
    expect(cancelLargeFile).toHaveBeenCalledTimes(1)
  })

  it('does not cancel when finish response body is ambiguous', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 200_000 })
    const inner = sim.transport()
    let cancelCalls = 0
    const ambiguousFinish: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const response = await inner.send(req)
        if (req.url.includes('b2_cancel_large_file')) cancelCalls += 1
        if (req.url.includes('b2_finish_large_file')) {
          return {
            ...response,
            json: () => Promise.reject(new SyntaxError('malformed stream finish body')),
          }
        }
        return response
      },
    }
    const failClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: ambiguousFinish,
      retry: { maxRetries: 0 },
    })
    await failClient.authorize()
    const failBucket = await failClient.createBucket({
      bucketName: 'stream-finish-body-lost',
      bucketType: BucketType.AllPrivate,
    })
    const cleanupFailures: string[] = []

    const { writable, done } = failBucket.file('ambiguous-stream.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
      onCleanupFailure: (event) => {
        expect(event.reason).toBe('finish-ambiguous')
        cleanupFailures.push(event.fileId)
      },
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(200_000))

    await expect(writer.close()).rejects.toBeInstanceOf(FinishLargeFileResponseBodyError)
    await expect(done).rejects.toMatchObject({
      bucketId: failBucket.id,
      fileName: 'ambiguous-stream.bin',
    })
    expect(cancelCalls).toBe(0)
    expect(cleanupFailures).toHaveLength(1)
  })

  it('passes the abort signal to finish during close', async () => {
    const controller = new AbortController()
    const finishStarted = Promise.withResolvers<AbortSignal>()
    vi.spyOn(client.raw, 'finishLargeFile').mockImplementation(
      async (_apiUrl, _authToken, _request, options) => {
        if (options?.signal === undefined) throw new Error('expected finish abort signal')
        finishStarted.resolve(options.signal)
        return await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    )
    const cancelLargeFile = vi.spyOn(client.raw, 'cancelLargeFile')

    const { writable, done } = bucket.file('abort-stream-finish.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
      signal: controller.signal,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(200_000))
    const close = writer.close()
    const finishSignal = await finishStarted.promise

    controller.abort(new Error('stream finish abort'))

    await expect(close).rejects.toThrow('stream finish abort')
    await expect(done).rejects.toThrow('stream finish abort')
    expect(finishSignal.aborted).toBe(true)
    expect(cancelLargeFile).toHaveBeenCalledTimes(1)
  })

  it('aborts a stalled in-flight part request when writer.abort() is called', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 200_000 })
    const inner = sim.transport()
    const uploadPartStarted = Promise.withResolvers<AbortSignal>()
    const uploadPartAborted = Promise.withResolvers<void>()
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          if (req.signal === undefined) throw new Error('expected upload part signal')
          uploadPartStarted.resolve(req.signal)
          return await new Promise<HttpResponse>((_resolve, reject) => {
            req.signal?.addEventListener(
              'abort',
              () => {
                uploadPartAborted.resolve()
                reject(req.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
              },
              { once: true },
            )
          })
        }
        return inner.send(req)
      },
    }
    const stalledClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await stalledClient.authorize()
    const stalledBucket = await stalledClient.createBucket({
      bucketName: 'stream-stalled-part-abort',
      bucketType: BucketType.AllPrivate,
    })

    const { writable, done } = stalledBucket.file('stalled-part.bin').createWriteStream({
      partSize: 100_000,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(deterministicBytes(100_000))
    const partSignal = await uploadPartStarted.promise

    await writer.abort(new Error('stop stalled part'))
    await uploadPartAborted.promise

    expect(partSignal.aborted).toBe(true)
    const rejection = await done.then(
      () => null,
      (err) => err,
    )
    expect(rejection).toBeInstanceOf(Error)
    expect(rejection.message).toContain('stop stalled part')
  })
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rejectOnAbort<T>(signal: AbortSignal | undefined, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    const rejectWithAbort = () => reject(signal?.reason ?? new Error(message))
    if (signal?.aborted === true) {
      rejectWithAbort()
      return
    }
    signal?.addEventListener('abort', rejectWithAbort, { once: true })
  })
}
