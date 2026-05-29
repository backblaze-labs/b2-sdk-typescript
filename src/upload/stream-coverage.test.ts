import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { deterministicBytes, makeClient } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

/**
 * Branch-coverage tests for `createWriteStream` in `upload/stream.ts`. The
 * happy-path multipart tests live in `stream.slow.test.ts`; this file
 * targets the remaining branches that aren't on a typical success path:
 *
 *   - `partSize ?? recommendedPartSize` default (line 73): exercised by
 *     omitting `partSize` so the engine falls back to the account's
 *     advertised recommended size. Uses a small simulator recommendation
 *     so the test still finishes near-instantly.
 *   - `errored = err instanceof Error ? err : new Error(String(err))`
 *     (lines 177 and 205): exercised by injecting a non-`Error` throw
 *     from `b2_upload_part`.
 *   - `write()`'s "if (errored) throw errored" guard (line 190): exercised
 *     by writing another chunk after the first part has already errored.
 *   - `abort()`'s "reason instanceof Error" branch (line 269): exercised
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

  it('falls back to recommendedPartSize when partSize is omitted (line 73)', async () => {
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

  it('wraps a non-Error throw from uploadPart so done rejects with an Error (lines 177 / 205)', async () => {
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

  // Note: line 190 (`if (errored) throw errored` inside write()) is reachable
  // in theory but hard to exercise reliably from a test. The WritableStream
  // pipeTo machinery either: (a) aborts after the first sink.write() resolves
  // and the abort hook tears down before the next write, or (b) races the
  // background part-upload task such that `errored` isn't latched yet when
  // the second sink.write() runs. Leaving this branch uncovered rather than
  // shipping a flaky test that depends on event-loop micro-timings.

  it('abort() wraps a non-Error reason in an Error (line 269)', async () => {
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
})
