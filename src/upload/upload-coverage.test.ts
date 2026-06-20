import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import { B2SsrfError } from '../errors/index.ts'
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
import type { UploadRetryEvent } from './retry.ts'

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
  authorizeCalls: number
}

type UploadUrlBody = { uploadUrl: string; authorizationToken: string } & Record<string, unknown>
interface UploadFailureSpec {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly count: number
}

function freshUrlRetryHarness(
  inner: HttpTransport,
  failFirst: 'file' | 'part',
  failure: UploadFailureSpec = {
    status: 500,
    code: 'internal_error',
    message: 'first upload URL failed',
    count: 1,
  },
): FreshUrlRetryHarness {
  const stats: FreshUrlRetryHarness = {
    uploadFileUrls: [],
    uploadPartUrls: [],
    getUploadUrlCalls: 0,
    getUploadPartUrlCalls: 0,
    uploadFileAttempts: 0,
    uploadPartAttempts: 0,
    authorizeCalls: 0,
    transport: {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_authorize_account')) {
          stats.authorizeCalls += 1
        }

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
          if (failFirst === 'file' && stats.uploadFileAttempts <= failure.count) {
            return jsonErrorResponse(failure.status, failure.code, failure.message)
          }
        }

        if (req.url.includes('b2_upload_part?')) {
          stats.uploadPartAttempts += 1
          stats.uploadPartUrls.push(req.url)
          if (failFirst === 'part' && stats.uploadPartAttempts <= failure.count) {
            return jsonErrorResponse(failure.status, failure.code, failure.message)
          }
        }

        return inner.send(req)
      },
    },
  }
  return stats
}

async function countFileVersions(bucket: Bucket, fileName: string): Promise<number> {
  const versions = await bucket.listFileVersions({ prefix: fileName })
  return versions.files.filter((file) => file.fileName === fileName).length
}

describe('uploadLargeFile cleanup paths', () => {
  it('evicts the part upload URL and rethrows when b2_upload_part fails', async () => {
    // Wrap the simulator so the second `b2_upload_part` call returns 400.
    // Fail every part-upload (not the URL fetch). With concurrency=1 the
    // first part is dispatched and fails, the engine then enters the
    // evict-then-rethrow path.
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
    // fail, so the outer cleanup's best-effort swallow runs. The original upload_part error must still be
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

  it('bounds duplicate small-file versions when success is stored but 5xx is returned', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    const maxRetries = 2
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&stored=${getUploadUrlCalls}`,
          })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          await inner.send(req)
          return jsonErrorResponse(500, 'internal_error', 'stored but response failed')
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stored-then-500',
      bucketType: BucketType.AllPrivate,
    })

    const retryEvents: UploadRetryEvent[] = []
    await expect(
      bucket.upload({
        fileName: 'duplicate.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        onUploadRetry: (event) => retryEvents.push(event),
      }),
    ).rejects.toThrow(/stored but response failed/)

    expect(uploadAttempts).toBe(maxRetries + 1)
    expect(getUploadUrlCalls).toBe(maxRetries + 1)
    expect(retryEvents.map((event) => event.attempt)).toEqual([1, 2])
    expect(await countFileVersions(bucket, 'duplicate.txt')).toBe(maxRetries + 1)
  })

  it('shares the retry budget with fresh upload URL fetch failures', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    const maxRetries = 2
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          if (getUploadUrlCalls <= maxRetries) {
            return jsonErrorResponse(500, 'internal_error', 'fresh URL fetch failed')
          }
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&budget=${getUploadUrlCalls}`,
          })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          return jsonErrorResponse(500, 'internal_error', 'upload pod failed')
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'fresh-url-budget',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'budget.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(/upload pod failed/)

    expect(getUploadUrlCalls).toBe(maxRetries + 1)
    expect(uploadAttempts).toBe(1)
  })

  it('stops sending payloads immediately when aborted from the upload retry callback', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let uploadAttempts = 0
    const controller = new AbortController()
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          await inner.send(req)
          return jsonErrorResponse(500, 'internal_error', 'stored but response failed')
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 5, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'abort-payload-retry',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'abort-duplicate.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        signal: controller.signal,
        onUploadRetry: () => controller.abort(),
      }),
    ).rejects.toThrow()

    expect(uploadAttempts).toBe(1)
    expect(await countFileVersions(bucket, 'abort-duplicate.txt')).toBe(1)
  })

  it('retries a lost 2xx upload response body read only when explicitly enabled', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let uploadAttempts = 0
    let getUploadUrlCalls = 0
    const retryEvents: UploadRetryEvent[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({ ...body, uploadUrl: `${body.uploadUrl}&body=${getUploadUrlCalls}` })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          const response = await inner.send(req)
          if (uploadAttempts === 1) {
            return {
              ...response,
              json: () => Promise.reject(new TypeError('response body lost')),
            }
          }
          return response
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'lost-body',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'lost-body.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      retryResponseBodyFailures: true,
      onUploadRetry: (event) => retryEvents.push(event),
    })

    expect(result.fileName).toBe('lost-body.txt')
    expect(uploadAttempts).toBe(2)
    expect(getUploadUrlCalls).toBe(2)
    expect(retryEvents).toHaveLength(1)
    expect(await countFileVersions(bucket, 'lost-body.txt')).toBe(2)
  })

  it('does not retry after a lost 2xx upload response body by default', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let uploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          const response = await inner.send(req)
          return {
            ...response,
            json: () => Promise.reject(new TypeError('response body lost')),
          }
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'lost-body-disabled',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'lost-body-disabled.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(/response body lost/)

    expect(uploadAttempts).toBe(1)
    expect(await countFileVersions(bucket, 'lost-body-disabled.txt')).toBe(1)
  })

  it('does not retry upload URLs rejected by the SSRF guard', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let guardedUploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({
            ...body,
            uploadUrl: 'http://169.254.169.254/latest/meta-data/b2_upload_file',
          })
        }
        if (req.url.includes('169.254.169.254')) {
          guardedUploadAttempts += 1
          throw new B2SsrfError('literal IP host not allowed by SSRF guard', req.url)
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'ssrf-upload-url',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'ssrf.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toBeInstanceOf(B2SsrfError)

    expect(getUploadUrlCalls).toBe(1)
    expect(guardedUploadAttempts).toBe(1)
  })

  it('refreshes a stale pooled upload URL reported as bad_request', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&fresh=${getUploadUrlCalls}`,
          })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          if (req.url.includes('pooled=stale')) {
            return jsonErrorResponse(400, 'bad_request', 'Upload URL expired')
          }
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stale-upload-url',
      bucketType: BucketType.AllPrivate,
    })
    const pooled = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    client.accountInfo.returnUploadUrl(bucket.id, {
      uploadUrl: `${pooled.uploadUrl}&pooled=stale`,
      authorizationToken: pooled.authorizationToken,
    })
    getUploadUrlCalls = 0

    const result = await bucket.upload({
      fileName: 'stale-url.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('stale-url.txt')
    expect(uploadAttempts).toBe(2)
    expect(getUploadUrlCalls).toBe(1)
  })

  it('does not retry deterministic bad_request upload failures', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let uploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          return jsonErrorResponse(400, 'bad_request', 'Sha1 did not match data received')
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'checksum-bad-request',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'bad-request.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(/Sha1 did not match/)

    expect(uploadAttempts).toBe(1)
  })

  it('passes the abort signal to fresh upload URL fetches', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    const controller = new AbortController()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    let sawFreshFetchSignal = false
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          if (getUploadUrlCalls === 2) {
            sawFreshFetchSignal = req.signal === controller.signal
            controller.abort()
            throw new DOMException('Aborted', 'AbortError')
          }
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          return jsonErrorResponse(500, 'internal_error', 'first upload failed')
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 5, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'abort-url-fetch',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'abort-fetch.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        signal: controller.signal,
      }),
    ).rejects.toThrow()

    expect(sawFreshFetchSignal).toBe(true)
    expect(getUploadUrlCalls).toBe(2)
    expect(uploadAttempts).toBe(1)
  })

  it('retries 429 upload failures in place without fetching a fresh URL', async () => {
    const sim = new B2Simulator()
    const harness = freshUrlRetryHarness(sim.transport(), 'file', {
      status: 429,
      code: 'too_many_requests',
      message: 'slow down',
      count: 1,
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'retry-429',
      bucketType: BucketType.AllPrivate,
    })

    const retryEvents: UploadRetryEvent[] = []
    const result = await bucket.upload({
      fileName: 'retry-429.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      onUploadRetry: (event) => retryEvents.push(event),
    })

    expect(result.fileName).toBe('retry-429.txt')
    expect(harness.getUploadUrlCalls).toBe(1)
    expect(harness.uploadFileAttempts).toBe(2)
    expect(harness.uploadFileUrls[0]).toBe(harness.uploadFileUrls[1])
    expect(retryEvents).toEqual([])
  })

  it('retries upload network failures with a fresh URL', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({
            ...body,
            uploadUrl: `${body.uploadUrl}&network=${getUploadUrlCalls}`,
          })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          if (uploadAttempts === 1) {
            throw new TypeError('socket closed')
          }
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'retry-network',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'retry-network.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('retry-network.txt')
    expect(uploadAttempts).toBe(2)
    expect(getUploadUrlCalls).toBe(2)
  })

  it('recovers expired upload tokens through fresh URL retry without reauth', async () => {
    const sim = new B2Simulator()
    const harness = freshUrlRetryHarness(sim.transport(), 'file', {
      status: 401,
      code: 'expired_auth_token',
      message: 'expired upload token',
      count: 1,
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'expired-upload-token',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'expired-token.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('expired-token.txt')
    expect(harness.authorizeCalls).toBe(1)
    expect(harness.getUploadUrlCalls).toBe(2)
    expect(harness.uploadFileAttempts).toBe(2)
  })

  it('recovers bad upload tokens through fresh URL retry for small files', async () => {
    const sim = new B2Simulator()
    const harness = freshUrlRetryHarness(sim.transport(), 'file', {
      status: 401,
      code: 'bad_auth_token',
      message: 'bad upload token',
      count: 1,
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'bad-upload-token-small',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'bad-token-small.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('bad-token-small.txt')
    expect(harness.getUploadUrlCalls).toBe(2)
    expect(harness.uploadFileAttempts).toBe(2)
    expect(harness.uploadFileUrls[0]).not.toBe(harness.uploadFileUrls[1])
  })

  it('recovers bad upload tokens through fresh URL retry for multipart parts', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const harness = freshUrlRetryHarness(sim.transport(), 'part', {
      status: 401,
      code: 'bad_auth_token',
      message: 'bad part upload token',
      count: 1,
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'bad-upload-token-part',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'bad-token-part.bin',
      source: new BufferSource(deterministicBytes(200_000)),
      partSize: 100_000,
      concurrency: 1,
    })

    expect(result.fileName).toBe('bad-token-part.bin')
    expect(harness.getUploadPartUrlCalls).toBe(2)
    expect(harness.uploadPartAttempts).toBe(3)
    expect(harness.uploadPartUrls[0]).not.toBe(harness.uploadPartUrls[1])
  })

  it('retries 429 part upload failures in place without fetching a fresh part URL', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const harness = freshUrlRetryHarness(sim.transport(), 'part', {
      status: 429,
      code: 'too_many_requests',
      message: 'slow down',
      count: 1,
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: harness.transport,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'retry-429-part',
      bucketType: BucketType.AllPrivate,
    })

    const retryEvents: UploadRetryEvent[] = []
    const result = await bucket.upload({
      fileName: 'retry-429-part.bin',
      source: new BufferSource(deterministicBytes(200_000)),
      partSize: 100_000,
      concurrency: 1,
      onUploadRetry: (event) => retryEvents.push(event),
    })

    expect(result.fileName).toBe('retry-429-part.bin')
    expect(harness.getUploadPartUrlCalls).toBe(1)
    expect(harness.uploadPartAttempts).toBe(3)
    expect(harness.uploadPartUrls[0]).toBe(harness.uploadPartUrls[1])
    expect(retryEvents).toEqual([])
  })
})

describe('upload scoped handles ignore runtime scope overrides', () => {
  it('keeps Bucket.upload small-file uploads in the bound bucket', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bound = await client.createBucket({
      bucketName: 'bound-small',
      bucketType: BucketType.AllPrivate,
    })
    const other = await client.createBucket({
      bucketName: 'other-small',
      bucketType: BucketType.AllPrivate,
    })

    const hostileOptions = {
      bucketId: other.id,
      fileName: 'scoped-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    } as unknown as Parameters<typeof bound.upload>[0]
    await bound.upload(hostileOptions)

    expect(await bound.getFileInfoByName('scoped-small.txt')).not.toBeNull()
    expect(await other.getFileInfoByName('scoped-small.txt')).toBeNull()
  })

  it('keeps Bucket.upload multipart uploads in the bound bucket', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bound = await client.createBucket({
      bucketName: 'bound-large',
      bucketType: BucketType.AllPrivate,
    })
    const other = await client.createBucket({
      bucketName: 'other-large',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const hostileOptions = {
      bucketId: other.id,
      fileName: 'scoped-large.bin',
      source: new BufferSource(deterministicBytes(partSize * 2)),
      partSize,
      concurrency: 1,
    } as unknown as Parameters<typeof bound.upload>[0]
    await bound.upload(hostileOptions)

    expect(await bound.getFileInfoByName('scoped-large.bin')).not.toBeNull()
    expect(await other.getFileInfoByName('scoped-large.bin')).toBeNull()
  })

  it('keeps B2Object.upload small-file uploads on the bound bucket and name', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bound = await client.createBucket({
      bucketName: 'object-bound-small',
      bucketType: BucketType.AllPrivate,
    })
    const other = await client.createBucket({
      bucketName: 'object-other-small',
      bucketType: BucketType.AllPrivate,
    })
    const object = bound.file('allowed-small.txt')

    const hostileOptions = {
      bucketId: other.id,
      fileName: 'escaped-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    } as unknown as Parameters<typeof object.upload>[0]
    await object.upload(hostileOptions)

    expect(await bound.getFileInfoByName('allowed-small.txt')).not.toBeNull()
    expect(await bound.getFileInfoByName('escaped-small.txt')).toBeNull()
    expect(await other.getFileInfoByName('escaped-small.txt')).toBeNull()
  })

  it('keeps B2Object.upload multipart uploads on the bound bucket and name', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bound = await client.createBucket({
      bucketName: 'object-bound-large',
      bucketType: BucketType.AllPrivate,
    })
    const other = await client.createBucket({
      bucketName: 'object-other-large',
      bucketType: BucketType.AllPrivate,
    })
    const object = bound.file('allowed-large.bin')

    const partSize = 100_000
    const hostileOptions = {
      bucketId: other.id,
      fileName: 'escaped-large.bin',
      source: new BufferSource(deterministicBytes(partSize * 2)),
      partSize,
      concurrency: 1,
    } as unknown as Parameters<typeof object.upload>[0]
    await object.upload(hostileOptions)

    expect(await bound.getFileInfoByName('allowed-large.bin')).not.toBeNull()
    expect(await bound.getFileInfoByName('escaped-large.bin')).toBeNull()
    expect(await other.getFileInfoByName('escaped-large.bin')).toBeNull()
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

  it('forwards serverSideEncryption when no resume candidate exists', async () => {
    // resume=true with no unfinished candidate falls through to the
    // start_large_file branch. With SSE-B2 supplied we hit the conditional spread.
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

  it('forwards fileRetention when no resume candidate exists', async () => {
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

  it('forwards legalHold when no resume candidate exists', async () => {
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
    // Force b2_upload_file to return 400. uploadSmallFile must call
    // evictUploadUrl and rethrow.
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
