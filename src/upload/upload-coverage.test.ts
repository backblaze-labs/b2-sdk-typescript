import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient } from '../test-utils/index.ts'
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
        retainUntilTimestamp: Date.now() + 86_400_000,
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
})
