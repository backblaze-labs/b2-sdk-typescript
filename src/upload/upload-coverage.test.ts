import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource, StreamSource } from '../streams/source.ts'
import {
  daysFromNow,
  deterministicBytes,
  jsonErrorResponse,
  jsonResponse,
  makeClient,
} from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'
import { uploadLargeFile } from './large.ts'

/**
 * Branch-coverage tests for `uploadLargeFile` and `uploadSmallFile`. These
 * exercise the error-handling and option-spreading paths that the success-
 * focused `upload.test.ts` and `upload.slow.test.ts` files don't touch:
 *
 *   - `uploadLargeFile` catch block: `accountInfo.evictPartUploadUrl` + rethrow
 *     when `b2_upload_part` fails.
 *   - `uploadLargeFile` outer cleanup: `cancelLargeFile` itself failing inside
 *     the catch (best-effort swallow).
 *   - `uploadLargeFile` resume=true with no candidate: the spread branches
 *     for `serverSideEncryption`, `fileRetention`, and `legalHold` inside
 *     the start-large-file call.
 *   - `uploadSmallFile` catch block: `accountInfo.evictUploadUrl` + rethrow.
 *
 * Every test uses a `minimumPartSize: 100_000` simulator so the multipart
 * round-trip fits comfortably under the fast-tier budget.
 */

function makeSmallPartClient(): { client: B2Client; sim: B2Simulator } {
  return makeClient({ minimumPartSize: 100_000 })
}

interface FreshUrlRetryHarness {
  readonly transport: HttpTransport
  readonly uploadFileUrls: string[]
  readonly uploadPartUrls: string[]
  getUploadUrlCalls: number
  getUploadPartUrlCalls: number
  uploadFileAttempts: number
  uploadPartAttempts: number
}

type UploadUrlBody = { uploadUrl: string; authorizationToken: string } & Record<string, unknown>

function freshUrlRetryHarness(
  inner: HttpTransport,
  failFirst: 'file' | 'part',
): FreshUrlRetryHarness {
  const stats: FreshUrlRetryHarness = {
    uploadFileUrls: [],
    uploadPartUrls: [],
    getUploadUrlCalls: 0,
    getUploadPartUrlCalls: 0,
    uploadFileAttempts: 0,
    uploadPartAttempts: 0,
    transport: {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          stats.getUploadUrlCalls += 1
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&freshSmall=${stats.getUploadUrlCalls}`,
          })
        }

        if (req.url.includes('b2_get_upload_part_url')) {
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          stats.getUploadPartUrlCalls += 1
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&freshPart=${stats.getUploadPartUrlCalls}`,
          })
        }

        if (req.url.includes('b2_upload_file?')) {
          stats.uploadFileAttempts += 1
          stats.uploadFileUrls.push(req.url)
          if (failFirst === 'file' && stats.uploadFileAttempts === 1) {
            return jsonErrorResponse(500, 'internal_error', 'first upload URL failed')
          }
        }

        if (req.url.includes('b2_upload_part?')) {
          stats.uploadPartAttempts += 1
          stats.uploadPartUrls.push(req.url)
          if (failFirst === 'part' && stats.uploadPartAttempts === 1) {
            return jsonErrorResponse(500, 'internal_error', 'first part upload URL failed')
          }
        }

        return inner.send(req)
      },
    },
  }
  return stats
}

describe('uploadLargeFile cleanup paths', () => {
  it('evicts the part upload URL and rethrows when b2_upload_part fails', async () => {
    // Wrap the simulator so the second `b2_upload_part` call returns 400.
    // Fail every part-upload (not the URL fetch). With concurrency=1 the
    // first part is dispatched and fails, the engine then enters the
    // evict-then-rethrow catch (upload/large.ts:201-204).
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 400,
      code: 'bad_request',
      message: 'simulated upload_part failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-part-fail',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    // Two full parts so we definitely hit `b2_upload_part` twice.
    const data = deterministicBytes(partSize * 2)

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'boom.bin',
        source: new BufferSource(data),
        partSize,
        concurrency: 1,
      }),
    ).rejects.toThrow(/simulated upload_part failure/)

    // The outer catch must have called cancelLargeFile so no orphan file
    // is left behind.
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'boom.bin')).toBeUndefined()
  })

  it('swallows a failing cancelLargeFile during the outer cleanup catch', async () => {
    // Force EVERY `b2_upload_part` to fail AND `b2_cancel_large_file` to
    // fail, so the outer cleanup's inner try/catch hits line 223-225 (the
    // best-effort swallow). The original upload_part error must still be
    // the one that propagates to the caller.
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    // Match the part-upload URL (`b2_upload_part?fileId=`) — using bare
    // `b2_upload_part` would also match `b2_get_upload_part_url` and
    // break URL fetching.
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 400,
      code: 'bad_request',
      message: 'simulated upload_part failure',
    })
    sim.injectFailure({
      on: 'b2_cancel_large_file',
      status: 500,
      code: 'internal_error',
      message: 'simulated cancel failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'cancel-fail',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'cleanup-boom.bin',
        source: new BufferSource(data),
        partSize,
        concurrency: 1,
      }),
    ).rejects.toThrow(/upload_part failure/)
  })
})

describe('upload fresh-URL retry', () => {
  it('retries a transient small-file upload failure with a fresh upload URL', async () => {
    const sim = new B2Simulator()
    const harness = freshUrlRetryHarness(sim.transport(), 'file')
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'small-fresh-url',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'fresh-small.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('fresh-small.txt')
    expect(harness.getUploadUrlCalls).toBe(2)
    expect(harness.uploadFileAttempts).toBe(2)
    expect(harness.uploadFileUrls).toHaveLength(2)
    expect(harness.uploadFileUrls[0]).not.toBe(harness.uploadFileUrls[1])
  })

  it('retries a transient multipart part failure with a fresh part URL', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const harness = freshUrlRetryHarness(sim.transport(), 'part')
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'part-fresh-url',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const result = await bucket.upload({
      fileName: 'fresh-part.bin',
      source: new BufferSource(payload),
      partSize,
      concurrency: 1,
    })

    expect(result.fileName).toBe('fresh-part.bin')
    expect(harness.getUploadPartUrlCalls).toBe(2)
    expect(harness.uploadPartAttempts).toBe(3)
    expect(harness.uploadPartUrls).toHaveLength(3)
    expect(harness.uploadPartUrls[0]).not.toBe(harness.uploadPartUrls[1])
  })

  it('retries a transient streaming-source part failure with a fresh part URL', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const harness = freshUrlRetryHarness(sim.transport(), 'part')
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-source-fresh-url',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    const result = await bucket.upload({
      fileName: 'fresh-stream-source.bin',
      source: new StreamSource(readable, payload.byteLength),
      partSize,
      concurrency: 1,
    })

    expect(result.fileName).toBe('fresh-stream-source.bin')
    expect(harness.getUploadPartUrlCalls).toBe(2)
    expect(harness.uploadPartAttempts).toBe(3)
    expect(harness.uploadPartUrls[0]).not.toBe(harness.uploadPartUrls[1])
  })

  it('retries a transient write-stream part failure with a fresh part URL', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const harness = freshUrlRetryHarness(sim.transport(), 'part')
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'write-stream-fresh-url',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const { writable, done } = bucket.file('fresh-write-stream.bin').createWriteStream({
      partSize,
      concurrency: 1,
    })
    const writer = writable.getWriter()
    await writer.write(payload)
    await writer.close()
    const result = await done

    expect(result.fileName).toBe('fresh-write-stream.bin')
    expect(harness.getUploadPartUrlCalls).toBe(2)
    expect(harness.uploadPartAttempts).toBe(3)
    expect(harness.uploadPartUrls[0]).not.toBe(harness.uploadPartUrls[1])
  })
})

describe('uploadLargeFile resume=true with no candidate', () => {
  let client: B2Client
  let bucketId: string

  beforeEach(async () => {
    const { client: c } = makeSmallPartClient()
    client = c
    await client.authorize()
    const b = await client.createBucket({
      bucketName: 'resume-no-candidate',
      bucketType: BucketType.AllPrivate,
    })
    bucketId = b.id
  })

  it('forwards serverSideEncryption when no resume candidate exists (line 115-117)', async () => {
    // resume=true with no unfinished candidate falls through to the
    // start_large_file branch at lines 107-121. With SSE-B2 supplied we
    // hit the conditional spread at 115-117.
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-sse.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      resume: true,
      serverSideEncryption: { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 },
    })
    expect(result.fileName).toBe('resume-sse.bin')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('forwards fileRetention when no resume candidate exists (line 118)', async () => {
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-retention.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      resume: true,
      fileRetention: {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: daysFromNow(1),
      },
    })
    expect(result.fileName).toBe('resume-retention.bin')
  })

  it('forwards legalHold when no resume candidate exists (line 119)', async () => {
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-hold.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      resume: true,
      legalHold: LegalHoldValue.On,
    })
    expect(result.fileName).toBe('resume-hold.bin')
  })
})

describe('uploadSmallFile cleanup path', () => {
  it('evicts the upload URL and rethrows when b2_upload_file fails', async () => {
    // Force b2_upload_file to return 400. uploadSmallFile's catch at lines
    // 97-100 must call evictUploadUrl and rethrow.
    const sim = new B2Simulator()
    // The small-file upload URL is `b2_upload_file?bucketId=...`. Matching
    // on `b2_upload_file?` is sufficient to distinguish from
    // `b2_upload_part`/`b2_get_upload_url`.
    sim.injectFailure({
      on: 'b2_upload_file?',
      status: 400,
      code: 'bad_request',
      message: 'simulated upload_file failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-small-fail',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'small-boom.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(/simulated upload_file failure/)
  })

  it('emits a ProgressEvent on small-file upload completion', async () => {
    // Regression: `uploadSmallFile` previously accepted `onProgress` on
    // its options but never wired it to a `ProgressTracker`, so callers
    // got silence for single-request uploads (while multipart uploads
    // emitted events correctly). After the wiring, the small-file path
    // should fire at least one event with the documented shape: a single
    // "part" worth of bytes, partsCompleted: 1, totalParts: 1.
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'small-progress',
      bucketType: BucketType.AllPrivate,
    })

    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const events: Array<{
      bytesTransferred: number
      totalBytes: number | null
      partsCompleted: number
      totalParts: number | null
    }> = []
    await bucket.upload({
      fileName: 'tiny.bin',
      source: new BufferSource(payload),
      onProgress: (event) => {
        events.push({
          bytesTransferred: event.bytesTransferred,
          totalBytes: event.totalBytes,
          partsCompleted: event.partsCompleted,
          totalParts: event.totalParts,
        })
      },
    })

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.bytesTransferred).toBe(payload.byteLength)
    expect(last?.totalBytes).toBe(payload.byteLength)
    expect(last?.partsCompleted).toBe(1)
    expect(last?.totalParts).toBe(1)
  })

  it("normalizes the wire 'none' contentSha1 sentinel to null on multipart uploads", async () => {
    // Real B2 stores per-part SHA-1s for multipart-finished files but
    // never a whole-file SHA-1; the wire returns the literal string
    // `'none'`. The SDK's `FileVersion.contentSha1` is typed `string |
    // null`, so the raw-client boundary collapses 'none' → null. Without
    // normalization, callers would have to write `=== 'none'` guards.
    // Both `minimumPartSize` AND `recommendedPartSize` need to be small
    // so `bucket.upload`'s small-vs-large dispatch picks the multipart
    // path for a 200 KB payload. Otherwise the file fits in the small
    // path and gets a real per-file SHA-1.
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'sha1-normalize',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const result = await bucket.upload({
      fileName: 'multipart.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
    })
    expect(result.contentSha1).toBeNull()

    // `getFileInfoByName` (which routes through listFileNames) sees the
    // same normalization at the list-response boundary.
    const info = await bucket.getFileInfoByName('multipart.bin')
    expect(info?.contentSha1).toBeNull()

    // Download response headers should normalize too. (B2 sends
    // `X-Bz-Content-Sha1: none`.)
    const dl = await bucket.download('multipart.bin')
    expect(dl.headers.contentSha1).toBeNull()
    await dl.body.cancel()
  })

  it('uploads a StreamSource through bucket.upload via the sequential multipart path', async () => {
    // Regression for the canSlice = false path: bucket.upload should
    // accept a StreamSource and stream multipart parts sequentially
    // (one partSize buffer in flight at a time), without requiring the
    // caller to pre-buffer the whole file. Without this fix,
    // `source.slice()` would throw inside uploadLargeFile.
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-multipart',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const totalSize = partSize * 2 + 1234
    const payload = deterministicBytes(totalSize)

    // Hand-roll a ReadableStream that emits the payload in small chunks
    // so the part-buffer assembly loop has to coalesce across reads.
    const chunkSize = 7919 // prime, doesn't divide partSize evenly
    let cursor = 0
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (cursor >= payload.byteLength) {
          controller.close()
          return
        }
        const end = Math.min(cursor + chunkSize, payload.byteLength)
        controller.enqueue(payload.subarray(cursor, end))
        cursor = end
      },
    })

    const result = await bucket.upload({
      fileName: 'streamed.bin',
      source: new StreamSource(readable, totalSize),
      partSize,
    })
    expect(result.fileName).toBe('streamed.bin')
    expect(result.contentLength).toBe(totalSize)
    // Multipart-finished files have no whole-file SHA-1: normalization
    // collapses 'none' to null (see the P2 normalization regression
    // above).
    expect(result.contentSha1).toBeNull()
  })

  it('forwards serverSideEncryption on each part of a streaming-source upload', async () => {
    // Covers the SSE conditional spread inside the streaming part loop.
    // The simulator accepts SSE-B2 without enforcing key material, so we
    // can verify it threads through without setting up real keys.
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-sse',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    const result = await bucket.upload({
      fileName: 'sse-stream.bin',
      source: new StreamSource(readable, payload.byteLength),
      partSize,
      serverSideEncryption: { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 },
    })
    expect(result.fileName).toBe('sse-stream.bin')
  })

  it('evicts the part-upload URL and rethrows when b2_upload_part fails on the streaming path', async () => {
    // Mirrors the parallel-path eviction test: when the underlying
    // b2_upload_part request fails, the sequential path must evict the
    // URL from the pool and rethrow so the outer cleanup can fire the
    // best-effort cancelLargeFile.
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 400,
      code: 'bad_request',
      message: 'simulated streaming upload_part failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-fail',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-boom.bin',
        source: new StreamSource(readable, payload.byteLength),
        partSize,
      }),
    ).rejects.toThrow(/simulated streaming upload_part failure/)

    // Cleanup ran: no orphan unfinished file.
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'stream-boom.bin')).toBeUndefined()
  })

  it('rejects a streaming-source upload when resume is requested', async () => {
    // StreamSource has no random access, so resume can't replay parts.
    // The engine bails early with a clear message and cancels the
    // started large file rather than silently buffering the whole
    // payload. The `resume` option lives on `uploadLargeFile` rather
    // than the high-level `bucket.upload`, so we call it directly.
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-resume',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'resume-stream.bin',
        source: new StreamSource(readable, payload.byteLength),
        partSize,
        concurrency: 1,
        resume: true,
      }),
    ).rejects.toThrow(/resume is not supported on non-sliceable sources/)
  })

  it('preserves a real contentSha1 hex digest for small-file uploads', async () => {
    // The normalization helper must NOT touch real SHA-1 hex digests:
    // small-file uploads have a real whole-file SHA-1.
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'sha1-preserve',
      bucketType: BucketType.AllPrivate,
    })
    const result = await bucket.upload({
      fileName: 'small.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    expect(result.contentSha1).not.toBeNull()
    expect(result.contentSha1).toMatch(/^[0-9a-f]{40}$/)
  })
})
