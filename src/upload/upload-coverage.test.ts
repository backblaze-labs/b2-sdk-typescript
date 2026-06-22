import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import {
  B2Error,
  B2SsrfError,
  FinishLargeFileResponseBodyError,
  NetworkError,
  ResumeFileIdMismatchError,
  TooManyRequestsError,
} from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import type { RawClient } from '../raw/index.ts'
import { B2Simulator } from '../simulator/index.ts'
import { sha1Hex } from '../streams/hash.ts'
import { BufferSource, type ContentSource, StreamSource, toContentSource } from '../streams/source.ts'
import {
  daysFromNow,
  deferred,
  deterministicBytes,
  jsonErrorResponse,
  jsonResponse,
  makeClient,
  readStream,
} from '../test-utils/index.ts'
import { BucketRetentionMode, BucketType } from '../types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode, sseCustomer } from '../types/encryption.ts'
import { bucketId, largeFileId } from '../types/ids.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'
import {
  cancelLargeFileBestEffort,
  cleanupRequestOptions,
  DEFAULT_CLEANUP_TIMEOUT_MS,
} from './cancel.ts'
import { type ResumePartReusedEvent, uploadLargeFile } from './large.ts'
import { type UploadRetryEvent, withFreshUploadUrlRetry } from './retry.ts'

/**
 * Branch-coverage tests for `uploadLargeFile` and `uploadSmallFile`. These
 * exercise the error-handling and option-spreading paths that the success-
 * focused `upload.test.ts` and `upload.slow.test.ts` files don't touch:
 *
 *   - `uploadLargeFile` catch block: `accountInfo.evictPartUploadUrl` + rethrow
 *     when `b2_upload_part` fails.
 *   - `uploadLargeFile` outer cleanup: `cancelLargeFile` itself failing inside
 *     the catch (best-effort swallow).
 *   - `uploadLargeFile` fresh multipart start: the spread branches
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

class FailingFirstSliceSource implements ContentSource {
  readonly canSlice = true
  readonly size: number
  readonly sliceStarts: number[] = []

  constructor(partSize: number) {
    this.size = partSize * 3
  }

  slice(start: number, end: number): ContentSource {
    this.sliceStarts.push(start)
    const length = end - start
    const shouldFail = start === 0
    return {
      canSlice: true,
      size: length,
      slice: () => {
        throw new Error('nested slice should not be used')
      },
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(length))
            controller.close()
          },
        }),
      toArrayBuffer: async () => {
        if (shouldFail) throw new Error('simulated source mutation')
        return new ArrayBuffer(length)
      },
    }
  }

  stream(): ReadableStream<Uint8Array> {
    throw new Error('parallel source stream should not be used')
  }

  toArrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('parallel source toArrayBuffer should not be used')
  }
}

class FailingSecondSliceAfterFirstUploadSource implements ContentSource {
  readonly canSlice = true
  readonly size: number
  private readonly partSize: number
  private readonly firstUploadStarted: Promise<void>

  constructor(partSize: number, firstUploadStarted: Promise<void>) {
    this.partSize = partSize
    this.size = partSize * 2
    this.firstUploadStarted = firstUploadStarted
  }

  slice(start: number, end: number): ContentSource {
    const length = end - start
    const firstUploadStarted = this.firstUploadStarted
    const shouldFail = start === this.partSize
    return {
      canSlice: true,
      size: length,
      slice: () => {
        throw new Error('nested slice should not be used')
      },
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(length))
            controller.close()
          },
        }),
      toArrayBuffer: async () => {
        if (shouldFail) {
          await firstUploadStarted
          throw new Error('simulated second part source failure')
        }
        return new ArrayBuffer(length)
      },
    }
  }

  stream(): ReadableStream<Uint8Array> {
    throw new Error('parallel source stream should not be used')
  }

  toArrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('parallel source toArrayBuffer should not be used')
  }
}

class AbortAwareParallelReadSource implements ContentSource {
  readonly canSlice = true
  readonly size: number
  siblingBytesRead = 0
  siblingCancelled = false
  private readonly siblingStarted: Promise<void>
  private resolveSiblingStarted!: () => void

  constructor(partSize: number) {
    this.size = partSize * 2
    this.siblingStarted = new Promise((resolve) => {
      this.resolveSiblingStarted = resolve
    })
  }

  slice(start: number, end: number): ContentSource {
    const length = end - start
    if (start === 0) {
      return {
        canSlice: true,
        size: length,
        slice: () => {
          throw new Error('nested slice should not be used')
        },
        stream: () => {
          throw new Error('failing slice stream should not be used')
        },
        toArrayBuffer: async () => {
          await this.siblingStarted
          throw new Error('simulated source mutation')
        },
      }
    }

    return {
      canSlice: true,
      size: length,
      slice: () => {
        throw new Error('nested slice should not be used')
      },
      stream: () => {
        throw new Error('sibling slice stream should not be used')
      },
      toArrayBuffer: (options: { readonly signal?: AbortSignal } = {}) =>
        this.readSiblingSlice(length, options.signal),
    }
  }

  stream(): ReadableStream<Uint8Array> {
    throw new Error('parallel source stream should not be used')
  }

  toArrayBuffer(): Promise<ArrayBuffer> {
    throw new Error('parallel source toArrayBuffer should not be used')
  }

  private readSiblingSlice(length: number, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
    this.resolveSiblingStarted()
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timeout !== undefined) clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        this.siblingCancelled = true
        cleanup()
        reject(signal?.reason ?? new Error('sibling read aborted'))
      }
      const readNext = () => {
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        if (this.siblingBytesRead >= length) {
          cleanup()
          resolve(new ArrayBuffer(length))
          return
        }
        this.siblingBytesRead += Math.min(1024, length - this.siblingBytesRead)
        timeout = setTimeout(readNext, 0)
      }

      signal?.addEventListener('abort', onAbort, { once: true })
      readNext()
    })
  }
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

  it('does not cancel an explicit resume file ID after upload failure', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 400,
      code: 'bad_request',
      message: 'simulated resumed upload_part failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'resume-part-fail',
      bucketType: BucketType.AllPrivate,
    })
    const start = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'resume-owned.bin',
        contentType: 'application/octet-stream',
      },
    )

    const partSize = 100_000
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'resume-owned.bin',
        source: new BufferSource(deterministicBytes(partSize * 2)),
        partSize,
        concurrency: 1,
        resumeFileId: start.fileId,
      }),
    ).rejects.toThrow(/simulated resumed upload_part failure/)

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileId === start.fileId)).toBeDefined()
  })

  it('bounds cleanup when the caller aborts and cancelLargeFile never settles', async () => {
    const controller = new AbortController()
    const abortReason = new Error('caller deadline')
    const fileId = largeFileId('cleanup-timeout-large-file')
    let cleanupTimeoutController!: AbortController
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      expect(timeoutMs).toBe(DEFAULT_CLEANUP_TIMEOUT_MS)
      cleanupTimeoutController = new AbortController()
      return cleanupTimeoutController.signal
    })
    let cleanupStarted!: () => void
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    let cleanupSignal: AbortSignal | undefined
    const raw = {
      async startLargeFile() {
        return { fileId }
      },
      async getUploadPartUrl() {
        return {
          uploadUrl: 'https://upload.example.test/part',
          authorizationToken: 'part-auth',
        }
      },
      async uploadPart() {
        controller.abort(abortReason)
        throw abortReason
      },
      cancelLargeFile(
        _apiUrl: string,
        _authToken: string,
        _request: { fileId: string },
        options?: { readonly signal?: AbortSignal },
      ) {
        cleanupSignal = options?.signal
        cleanupStarted()
        return new Promise<never>(() => {})
      },
      async finishLargeFile() {
        throw new Error('finishLargeFile should not be called')
      },
    } as unknown as RawClient
    const accountInfo = {
      getApiUrl: () => 'https://api.example.test',
      getAuthToken: () => 'auth',
      getRecommendedPartSize: () => 100_000,
      getAbsoluteMinimumPartSize: () => 100_000,
      checkoutPartUploadUrl: () => null,
      returnPartUploadUrl: () => {},
      evictPartUploadUrl: () => {},
    } as unknown as AccountInfo

    try {
      const uploadPromise = uploadLargeFile(raw, accountInfo, {
        bucketId: bucketId('bucket1'),
        fileName: 'cleanup-timeout.bin',
        source: new BufferSource(deterministicBytes(200_000)),
        partSize: 100_000,
        concurrency: 1,
        signal: controller.signal,
      })

      await cleanupStartedPromise
      expect(cleanupSignal?.aborted).toBe(false)
      cleanupTimeoutController.abort(new DOMException('Cleanup timed out', 'TimeoutError'))
      await expect(uploadPromise).rejects.toBe(abortReason)
      expect(cleanupSignal?.aborted).toBe(true)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('bounds direct best-effort cleanup when no signal is supplied', async () => {
    let cleanupTimeoutController!: AbortController
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      expect(timeoutMs).toBe(DEFAULT_CLEANUP_TIMEOUT_MS)
      cleanupTimeoutController = new AbortController()
      return cleanupTimeoutController.signal
    })
    let cleanupStarted!: () => void
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    let cleanupSignal: AbortSignal | undefined
    const raw = {
      cancelLargeFile(
        _apiUrl: string,
        _authToken: string,
        _request: { fileId: string },
        options?: { readonly signal?: AbortSignal },
      ) {
        cleanupSignal = options?.signal
        cleanupStarted()
        return new Promise<never>(() => {})
      },
    } as unknown as RawClient
    const accountInfo = {
      getApiUrl: () => 'https://api.example.test',
      getAuthToken: () => 'auth',
    } as unknown as AccountInfo

    try {
      const cleanup = cancelLargeFileBestEffort(
        raw,
        accountInfo,
        largeFileId('cleanup-timeout-large-file'),
      )

      await cleanupStartedPromise
      expect(cleanupSignal?.aborted).toBe(false)
      cleanupTimeoutController.abort(new DOMException('Cleanup timed out', 'TimeoutError'))
      await expect(cleanup).resolves.toBeUndefined()
      expect(cleanupSignal?.aborted).toBe(true)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('bounds direct best-effort cleanup when a caller signal is supplied', async () => {
    const caller = new AbortController()
    let cleanupTimeoutController!: AbortController
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs: number) => {
      expect(timeoutMs).toBe(DEFAULT_CLEANUP_TIMEOUT_MS)
      cleanupTimeoutController = new AbortController()
      return cleanupTimeoutController.signal
    })
    let cleanupStarted!: () => void
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve
    })
    let cleanupSignal: AbortSignal | undefined
    const raw = {
      cancelLargeFile(
        _apiUrl: string,
        _authToken: string,
        _request: { fileId: string },
        options?: { readonly signal?: AbortSignal },
      ) {
        cleanupSignal = options?.signal
        cleanupStarted()
        return new Promise<never>(() => {})
      },
    } as unknown as RawClient
    const accountInfo = {
      getApiUrl: () => 'https://api.example.test',
      getAuthToken: () => 'auth',
    } as unknown as AccountInfo

    try {
      const cleanup = cancelLargeFileBestEffort(
        raw,
        accountInfo,
        largeFileId('cleanup-timeout-large-file'),
        { signal: caller.signal },
      )

      await cleanupStartedPromise
      expect(cleanupSignal).not.toBe(caller.signal)
      expect(cleanupSignal?.aborted).toBe(false)
      cleanupTimeoutController.abort(new DOMException('Cleanup timed out', 'TimeoutError'))
      await expect(cleanup).resolves.toBeUndefined()
      expect(cleanupSignal?.aborted).toBe(true)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('falls back when AbortSignal cleanup helpers are unavailable', async () => {
    const originalTimeout = AbortSignal.timeout
    const originalAny = AbortSignal.any
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    try {
      const caller = new AbortController()
      const callerOptions = cleanupRequestOptions(caller.signal, 10_000)
      const callerReason = new Error('caller cleanup abort')
      caller.abort(callerReason)
      expect(callerOptions.signal.aborted).toBe(true)
      expect(callerOptions.signal.reason).toBe(callerReason)

      const timeoutOptions = cleanupRequestOptions(undefined, 1)
      await new Promise<void>((resolve) => {
        if (timeoutOptions.signal.aborted) {
          resolve()
          return
        }
        timeoutOptions.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      expect(timeoutOptions.signal.aborted).toBe(true)
      expect((timeoutOptions.signal.reason as Error).name).toBe('TimeoutError')
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        writable: true,
        value: originalTimeout,
      })
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: originalAny,
      })
    }
  })

  it('uses Error-shaped cleanup timeout reasons when DOMException is unavailable', async () => {
    const originalTimeout = AbortSignal.timeout
    const originalAny = AbortSignal.any
    const originalDomException = globalThis.DOMException
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, 'DOMException', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    try {
      const timeoutOptions = cleanupRequestOptions(undefined, 1)
      await new Promise<void>((resolve) => {
        if (timeoutOptions.signal.aborted) {
          resolve()
          return
        }
        timeoutOptions.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      expect(timeoutOptions.signal.reason).toMatchObject({
        message: 'Cleanup timed out',
        name: 'TimeoutError',
      })
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        writable: true,
        value: originalTimeout,
      })
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: originalAny,
      })
      Object.defineProperty(globalThis, 'DOMException', {
        configurable: true,
        writable: true,
        value: originalDomException,
      })
    }
  })

  it('clears fallback cleanup timers after successful cancellation', async () => {
    const originalTimeout = AbortSignal.timeout
    const originalAny = AbortSignal.any
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(AbortSignal, 'any', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    try {
      const raw = {
        cancelLargeFile: vi.fn(async () => ({
          fileId: 'cleanup-id',
          fileName: 'cleanup.bin',
        })),
      } as unknown as RawClient
      const accountInfo = {
        getApiUrl: () => 'https://api.example.test',
        getAuthToken: () => 'auth-token',
      } as unknown as AccountInfo

      await cancelLargeFileBestEffort(raw, accountInfo, largeFileId('cleanup-id'))

      const fallbackTimer = setTimeoutSpy.mock.results[setTimeoutSpy.mock.results.length - 1]?.value
      expect(fallbackTimer).toBeDefined()
      expect(clearTimeoutSpy).toHaveBeenCalledWith(fallbackTimer)
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        writable: true,
        value: originalTimeout,
      })
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: originalAny,
      })
    }
  })

  it('aborts and drains parallel part work before cancelling the large file', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    const inner = sim.transport()
    let part2Started!: () => void
    const part2StartedPromise = new Promise<void>((resolve) => {
      part2Started = resolve
    })
    let part2Settled = false
    let cancelSawPart2Settled: boolean | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part?')) {
          const partNumber = req.headers?.['X-Bz-Part-Number']
          if (partNumber === '1') {
            await part2StartedPromise
            return jsonErrorResponse(400, 'bad_request', 'forced part 1 failure')
          }
          if (partNumber === '2') {
            part2Started()
            return new Promise<HttpResponse>((_resolve, reject) => {
              const rejectWithAbort = () => {
                part2Settled = true
                reject(req.signal?.reason ?? new Error('part 2 aborted'))
              }
              if (req.signal?.aborted === true) {
                rejectWithAbort()
              } else {
                req.signal?.addEventListener('abort', rejectWithAbort, { once: true })
              }
            })
          }
        }
        if (req.url.includes('b2_cancel_large_file')) {
          cancelSawPart2Settled = part2Settled
        }
        return inner.send(req)
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
      bucketName: 'parallel-drain',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'parallel-drain.bin',
        source: new BufferSource(deterministicBytes(partSize * 2)),
        partSize,
        concurrency: 2,
      }),
    ).rejects.toThrow(/forced part 1 failure/)

    expect(part2Settled).toBe(true)
    expect(cancelSawPart2Settled).toBe(true)
  })

  it('aborts queued multipart sibling tasks after a source read fails', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'multipart-sibling-abort',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const source = new FailingFirstSliceSource(partSize)

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'changed.bin',
        source,
        partSize,
        concurrency: 1,
      }),
    ).rejects.toThrow('simulated source mutation')

    expect(source.sliceStarts).toEqual([0])
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'changed.bin')).toBeUndefined()
  })

  it('aborts in-flight parallel source reads after a sibling read fails', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'multipart-read-abort',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const source = new AbortAwareParallelReadSource(partSize)

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'changed-during-read.bin',
        source,
        partSize,
        concurrency: 2,
      }),
    ).rejects.toThrow('simulated source mutation')

    expect(source.siblingCancelled).toBe(true)
    expect(source.siblingBytesRead).toBeLessThan(partSize)
  })

  it('accepts an untriggered abort signal for multipart uploads', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'multipart-live-signal',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize * 2)
    const controller = new AbortController()
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'live-signal.bin',
      source: new BufferSource(payload),
      partSize,
      concurrency: 1,
      signal: controller.signal,
    })

    expect(result.fileName).toBe('live-signal.bin')
  })

  it('rejects a stream source that emits extra bytes after planned parts', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-extra-after-plan',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'stream-extra.bin',
        source: new StreamSource(readable, partSize),
        partSize,
        concurrency: 1,
      }),
    ).rejects.toThrow('source stream emitted more than advertised')
  })

  it('preserves the initiating multipart failure over sibling aborts', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let markFirstUploadStarted!: () => void
    const firstUploadStarted = new Promise<void>((resolve) => {
      markFirstUploadStarted = resolve
    })
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part?') && req.headers?.['X-Bz-Part-Number'] === '1') {
          markFirstUploadStarted()
          if (req.signal?.aborted) throw new DOMException('sibling aborted', 'AbortError')
          const signal = req.signal
          if (signal === undefined) throw new Error('missing part upload abort signal')
          await new Promise<never>((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('sibling aborted', 'AbortError')),
              { once: true },
            )
          })
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'multipart-root-cause',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'root-cause.bin',
        source: new FailingSecondSliceAfterFirstUploadSource(partSize, firstUploadStarted),
        partSize,
        concurrency: 2,
      }),
    ).rejects.toThrow('simulated second part source failure')
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
    const cleanupFailures: Array<{ fileId: string; error: unknown }> = []
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'cleanup-boom.bin',
        source: new BufferSource(data),
        partSize,
        concurrency: 1,
        onCleanupFailure: (event) =>
          cleanupFailures.push({ fileId: event.fileId, error: event.error }),
      }),
    ).rejects.toThrow(/upload_part failure/)
    expect(cleanupFailures).toHaveLength(1)
    expect(cleanupFailures[0]?.fileId).toMatch(/^4_z/)
    expect(cleanupFailures[0]?.error).toBeInstanceOf(Error)
  })

  it('does not cancel when finishLargeFile commits but its response body cannot be parsed', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let finishCalls = 0
    let cancelCalls = 0
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      retry: { maxRetries: 0 },
      transport: {
        async send(req: HttpRequest): Promise<HttpResponse> {
          const response = await inner.send(req)
          if (req.url.includes('b2_cancel_large_file')) cancelCalls += 1
          if (req.url.includes('b2_finish_large_file')) {
            finishCalls += 1
            return {
              ...response,
              json: () => Promise.reject(new SyntaxError('malformed finish response body')),
            }
          }
          return response
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'finish-body-lost',
      bucketType: BucketType.AllPrivate,
    })
    const partSize = 100_000

    let finishError: unknown
    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'ambiguous-finish.bin',
        source: new BufferSource(deterministicBytes(partSize * 2)),
        partSize,
        concurrency: 1,
        onCleanupFailure: (event) => {
          finishError = event.error
          expect(event.reason).toBe('finish-ambiguous')
          expect(event.fileId).toMatch(/^4_z/)
        },
      }),
    ).rejects.toBeInstanceOf(FinishLargeFileResponseBodyError)

    expect(finishCalls).toBe(1)
    expect(cancelCalls).toBe(0)
    expect(finishError).toBeInstanceOf(FinishLargeFileResponseBodyError)
    expect((finishError as FinishLargeFileResponseBodyError).fileId).toMatch(/^4_z/)
    expect((finishError as FinishLargeFileResponseBodyError).bucketId).toBe(bucket.id)
    expect((finishError as FinishLargeFileResponseBodyError).fileName).toBe('ambiguous-finish.bin')
    expect(await countFileVersions(bucket, 'ambiguous-finish.bin')).toBe(1)
  })

  it('does not cancel a forward-only upload with an ambiguous finish response', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let cancelCalls = 0
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      retry: { maxRetries: 0 },
      transport: {
        async send(req: HttpRequest): Promise<HttpResponse> {
          const response = await inner.send(req)
          if (req.url.includes('b2_cancel_large_file')) cancelCalls += 1
          if (req.url.includes('b2_finish_large_file')) {
            return {
              ...response,
              json: () => Promise.reject(new SyntaxError('malformed forward-only finish body')),
            }
          }
          return response
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'forward-only-finish-body-lost',
      bucketType: BucketType.AllPrivate,
    })
    const partSize = 100_000
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield deterministicBytes(partSize)
      yield deterministicBytes(partSize)
    }
    const cleanupFailures: string[] = []

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'forward-only-ambiguous-finish.bin',
        source: toContentSource(chunks(), partSize * 2),
        partSize,
        concurrency: 1,
        onCleanupFailure: (event) => {
          expect(event.reason).toBe('finish-ambiguous')
          cleanupFailures.push(event.fileId)
        },
      }),
    ).rejects.toMatchObject({
      bucketId: bucket.id,
      fileName: 'forward-only-ambiguous-finish.bin',
    })

    expect(cancelCalls).toBe(0)
    expect(cleanupFailures).toHaveLength(1)
  })

  it('aborts and drains parallel part work before cancelling the large file', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    let releasePartOneUpload: (() => void) | undefined
    const partOneUploadStarted = new Promise<void>((resolve) => {
      releasePartOneUpload = resolve
    })
    const uploadAttempts: number[] = []
    let uploadAttemptsAfterCancel = 0
    let cancelSeen = false
    const controller = new AbortController()
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_cancel_large_file')) {
          cancelSeen = true
          return inner.send(req)
        }
        if (req.url.includes('b2_upload_part?')) {
          if (cancelSeen) uploadAttemptsAfterCancel += 1
          const partNumber = Number(req.headers?.['X-Bz-Part-Number'])
          uploadAttempts.push(partNumber)
          if (partNumber === 1) {
            releasePartOneUpload?.()
            if (req.signal?.aborted === true) throw req.signal.reason
            await new Promise<never>((_, reject) => {
              req.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              )
            })
          }
        }
        return inner.send(req)
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
      bucketName: 'parallel-drain',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const data = deterministicBytes(partSize * 3)
    const source: ContentSource = {
      canSlice: true,
      size: data.byteLength,
      slice(start, end) {
        const partNumber = start / partSize + 1
        if (partNumber === 2) {
          return {
            canSlice: true,
            size: end - start,
            slice: () => {
              throw new Error('unexpected nested slice')
            },
            stream: () => new ReadableStream<Uint8Array>(),
            toArrayBuffer: async () => {
              await partOneUploadStarted
              throw new Error('part 2 read failed')
            },
          }
        }
        return new BufferSource(data.slice(start, end))
      },
      stream: () => new ReadableStream<Uint8Array>(),
      toArrayBuffer: async () => data.buffer as ArrayBuffer,
    }

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'parallel-drain.bin',
        source,
        partSize,
        concurrency: 2,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/part 2 read failed/)

    expect(cancelSeen).toBe(true)
    expect(uploadAttempts).toEqual([1])
    expect(uploadAttemptsAfterCancel).toBe(0)
  })
})

function makeMultipartAccountInfo(): AccountInfo {
  const entry = {
    uploadUrl: 'https://upload.example.test/b2_upload_part',
    authorizationToken: 'part-auth',
  }
  return {
    getApiUrl: () => 'https://api.example.test',
    getAuthToken: () => 'auth-token',
    getRecommendedPartSize: () => 2,
    getAbsoluteMinimumPartSize: () => 1,
    checkoutPartUploadUrl: () => entry,
    returnPartUploadUrl: () => {},
    evictPartUploadUrl: () => {},
  } as unknown as AccountInfo
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

describe('upload fresh-URL retry', () => {
  it('returns rate-limited upload URLs to the pool without retrying the payload', async () => {
    const entry = { uploadUrl: 'https://upload.example/file', authorizationToken: 'upload-token' }
    const rateLimitError = new B2Error({
      status: 429,
      code: 'too_many_requests',
      message: 'retry later',
    })
    const returnEntry = vi.fn()
    const evictEntry = vi.fn()

    await expect(
      withFreshUploadUrlRetry({
        fileName: 'rate-limited.txt',
        partNumber: null,
        retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
        retryResponseBodyFailures: false,
        checkout: () => entry,
        fetchFresh: async () => entry,
        returnEntry,
        evictEntry,
        upload: async () => {
          throw rateLimitError
        },
      }),
    ).rejects.toBe(rateLimitError)

    expect(returnEntry).toHaveBeenCalledWith(entry)
    expect(evictEntry).not.toHaveBeenCalled()
  })

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

  it('continues fresh-URL recovery when the upload retry observer throws', async () => {
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
      bucketName: 'retry-observer-throws',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'observer-throws.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      onUploadRetry: () => {
        throw new Error('metrics sink failed')
      },
    })

    expect(result.fileName).toBe('observer-throws.txt')
    expect(harness.getUploadUrlCalls).toBe(2)
    expect(harness.uploadFileAttempts).toBe(2)
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

  it('continues fresh-URL retry when the retry observer throws', async () => {
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
      bucketName: 'throwing-retry-observer',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'observer.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      onUploadRetry: () => {
        throw new Error('metrics sink failed')
      },
    })

    expect(result.fileName).toBe('observer.txt')
    expect(harness.uploadFileAttempts).toBe(2)
    expect(harness.getUploadUrlCalls).toBe(2)
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

  it('does not retry a lost 2xx upload response body read by default', async () => {
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
      bucketName: 'lost-body-default',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'lost-body-default.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(/response body lost/)

    expect(uploadAttempts).toBe(1)
    expect(await countFileVersions(bucket, 'lost-body-default.txt')).toBe(1)
  })

  it('can opt into retrying a lost 2xx upload response body read with a fresh URL', async () => {
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

  it('retries a truncated 2xx upload JSON body when explicitly enabled', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let uploadAttempts = 0
    let getUploadUrlCalls = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
          const response = await inner.send(req)
          const body = await response.json<UploadUrlBody>()
          return jsonResponse({ ...body, uploadUrl: `${body.uploadUrl}&json=${getUploadUrlCalls}` })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          const response = await inner.send(req)
          if (uploadAttempts === 1) {
            return {
              ...response,
              json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
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
      bucketName: 'truncated-body',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'truncated-body.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      retryResponseBodyFailures: true,
    })

    expect(result.fileName).toBe('truncated-body.txt')
    expect(uploadAttempts).toBe(2)
    expect(getUploadUrlCalls).toBe(2)
    expect(await countFileVersions(bucket, 'truncated-body.txt')).toBe(2)
  })

  it('can disable retry after a lost 2xx upload response body', async () => {
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
        retryResponseBodyFailures: false,
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

  it('does not retry network errors caused by blocked upload URLs', async () => {
    let uploadAttempts = 0
    let evictedEntries = 0
    let retryEvents = 0
    const entry = { uploadUrl: 'https://upload.example.test', authorizationToken: 'auth' }
    const ssrfError = new B2SsrfError(
      'literal IP host not allowed by SSRF guard',
      'http://169.254.169.254/latest/meta-data',
    )
    const networkError = new NetworkError('upload URL rejected', ssrfError)

    await expect(
      withFreshUploadUrlRetry({
        fileName: 'blocked-url.txt',
        partNumber: null,
        retry: { maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
        retryResponseBodyFailures: false,
        checkout: () => entry,
        fetchFresh: () => Promise.resolve(entry),
        returnEntry: () => {},
        evictEntry: () => {
          evictedEntries += 1
        },
        upload: () => {
          uploadAttempts += 1
          return Promise.reject(networkError)
        },
        onUploadRetry: () => {
          retryEvents += 1
        },
      }),
    ).rejects.toBe(networkError)

    expect(uploadAttempts).toBe(1)
    expect(evictedEntries).toBe(1)
    expect(retryEvents).toBe(0)
  })

  it('retries NetworkError from fresh upload URL fetch before a small upload POST', async () => {
    let freshFetches = 0
    let uploadAttempts = 0
    const retryEvents: UploadRetryEvent[] = []
    const networkError = new NetworkError('get_upload_url connection reset')
    const entry = { uploadUrl: 'https://upload.example.test', authorizationToken: 'auth' }

    const result = await withFreshUploadUrlRetry({
      fileName: 'fresh-url-network.txt',
      partNumber: null,
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
      retryResponseBodyFailures: false,
      checkout: () => null,
      fetchFresh: () => {
        freshFetches += 1
        if (freshFetches === 1) return Promise.reject(networkError)
        return Promise.resolve(entry)
      },
      returnEntry: () => {},
      evictEntry: () => {},
      upload: () => {
        uploadAttempts += 1
        return Promise.resolve('uploaded')
      },
      onUploadRetry: (event) => retryEvents.push(event),
    })

    expect(result).toBe('uploaded')
    expect(freshFetches).toBe(2)
    expect(uploadAttempts).toBe(1)
    expect(retryEvents).toHaveLength(1)
    expect(retryEvents[0]?.error).toBe(networkError)
  })

  it('throws retryable upload errors after the final retry attempt', async () => {
    let uploadAttempts = 0
    let freshFetches = 0
    const entry = { uploadUrl: 'https://upload.example.test', authorizationToken: 'auth' }
    const networkError = new NetworkError('socket closed')

    await expect(
      withFreshUploadUrlRetry({
        fileName: 'retry-budget.txt',
        partNumber: null,
        retry: { maxRetries: 0, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
        retryResponseBodyFailures: false,
        checkout: () => entry,
        fetchFresh: () => {
          freshFetches += 1
          return Promise.resolve(entry)
        },
        returnEntry: () => {},
        evictEntry: () => {},
        upload: () => {
          uploadAttempts += 1
          return Promise.reject(networkError)
        },
      }),
    ).rejects.toBe(networkError)

    expect(uploadAttempts).toBe(1)
    expect(freshFetches).toBe(0)
  })

  it('returns upload URLs before surfacing upload-layer rate limits', async () => {
    let uploadAttempts = 0
    let returnedEntries = 0
    let evictedEntries = 0
    const entry = { uploadUrl: 'https://upload.example.test', authorizationToken: 'auth' }
    const rateLimitError = new TooManyRequestsError({
      status: 429,
      code: 'too_many_requests',
      message: 'slow down',
    })

    await expect(
      withFreshUploadUrlRetry({
        fileName: 'rate-limited.txt',
        partNumber: null,
        retry: { maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
        retryResponseBodyFailures: false,
        checkout: () => entry,
        fetchFresh: () => Promise.resolve(entry),
        returnEntry: () => {
          returnedEntries += 1
        },
        evictEntry: () => {
          evictedEntries += 1
        },
        upload: () => {
          uploadAttempts += 1
          return Promise.reject(rateLimitError)
        },
      }),
    ).rejects.toBe(rateLimitError)

    expect(uploadAttempts).toBe(1)
    expect(returnedEntries).toBe(1)
    expect(evictedEntries).toBe(0)
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

  it('does not retry a single-file upload POST network error by default', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    let getUploadUrlCalls = 0
    let uploadAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_get_upload_url')) {
          getUploadUrlCalls += 1
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          await inner.send(req)
          throw new TypeError('socket closed after upload')
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
      bucketName: 'network-default-no-retry',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'network-default.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toThrow(NetworkError)

    expect(uploadAttempts).toBe(1)
    expect(getUploadUrlCalls).toBe(1)
    expect(await countFileVersions(bucket, 'network-default.txt')).toBe(1)
  })

  it('retries upload network failures with a fresh URL when explicitly enabled', async () => {
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
      retryResponseBodyFailures: true,
    })

    expect(result.fileName).toBe('retry-network.txt')
    expect(uploadAttempts).toBe(2)
    expect(getUploadUrlCalls).toBe(2)
  })

  it('retries upload DOMException failures with a fresh URL', async () => {
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
            uploadUrl: `${body.uploadUrl}&dom=${getUploadUrlCalls}`,
          })
        }
        if (req.url.includes('b2_upload_file?')) {
          uploadAttempts += 1
          if (uploadAttempts === 1) {
            throw new DOMException('upload timed out', 'TimeoutError')
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
      bucketName: 'retry-domexception',
      bucketType: BucketType.AllPrivate,
    })

    const result = await bucket.upload({
      fileName: 'retry-domexception.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })

    expect(result.fileName).toBe('retry-domexception.txt')
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

describe('uploadLargeFile fresh multipart metadata', () => {
  let client: B2Client
  let sim: B2Simulator
  let bucket: Bucket
  let bucketId: string

  beforeEach(async () => {
    const { client: c, sim: s } = makeSmallPartClient()
    client = c
    sim = s
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'resume-no-candidate',
      bucketType: BucketType.AllPrivate,
    })
    bucketId = bucket.id
  })

  it('forwards serverSideEncryption when starting a large file', async () => {
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-sse.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      serverSideEncryption: { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 },
    })
    expect(result.fileName).toBe('resume-sse.bin')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('forwards fileRetention when starting a large file', async () => {
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-retention.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      fileRetention: {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: daysFromNow(1),
      },
    })
    expect(result.fileName).toBe('resume-retention.bin')
  })

  it('forwards legalHold when starting a large file', async () => {
    const partSize = 100_000
    const data = new Uint8Array(partSize * 2)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-hold.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      legalHold: LegalHoldValue.On,
    })
    expect(result.fileName).toBe('resume-hold.bin')
  })

  it.each([
    {
      name: 'hidden retention',
      fileName: 'hidden-retention.bin',
      hiddenField: 'fileRetention' as const,
      startOptions: {
        fileRetention: {
          mode: RetentionMode.Governance,
          retainUntilTimestamp: daysFromNow(1),
        },
      },
    },
    {
      name: 'hidden legal hold',
      fileName: 'hidden-legal-hold.bin',
      hiddenField: 'legalHold' as const,
      startOptions: { legalHold: LegalHoldValue.On },
    },
  ])('starts fresh when omitted $name is unreadable', async (scenario) => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const response = await inner.send(req)
        if (!req.url.includes('b2_list_unfinished_large_files')) return response
        const body = await response.json<{
          files: Array<Record<string, unknown> & { fileName: string }>
          nextFileId: string | null
        }>()
        return jsonResponse({
          ...body,
          files: body.files.map((file) =>
            file.fileName === scenario.fileName
              ? {
                  ...file,
                  [scenario.hiddenField]: {
                    isClientAuthorizedToRead: false,
                    value: null,
                  },
                }
              : file,
          ),
        })
      },
    }
    const hiddenClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await hiddenClient.authorize()
    const hiddenBucket = await hiddenClient.createBucket({
      bucketName: scenario.fileName.replaceAll('.', '-'),
      bucketType: BucketType.AllPrivate,
    })
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const start = await hiddenClient.raw.startLargeFile(
      hiddenClient.accountInfo.getApiUrl(),
      hiddenClient.accountInfo.getAuthToken(),
      {
        bucketId: hiddenBucket.id,
        fileName: scenario.fileName,
        contentType: 'application/octet-stream',
        ...scenario.startOptions,
      },
    )
    const partUrl = await hiddenClient.raw.getUploadPartUrl(
      hiddenClient.accountInfo.getApiUrl(),
      hiddenClient.accountInfo.getAuthToken(),
      { fileId: start.fileId },
    )
    const part1 = data.slice(0, partSize)
    await hiddenClient.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1.byteLength,
        contentSha1: await sha1Hex(part1),
      },
      part1,
    )

    const rejected: string[] = []
    const reused: ResumePartReusedEvent[] = []
    const result = await uploadLargeFile(hiddenClient.raw, hiddenClient.accountInfo, {
      bucketId: hiddenBucket.id,
      fileName: scenario.fileName,
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 1,
      resume: true,
      onResumeCandidateRejected: (event) => rejected.push(event.reason),
      onResumePartReused: (event) => reused.push(event),
    })

    expect(result.fileName).toBe(scenario.fileName)
    expect(rejected).toEqual([
      scenario.hiddenField === 'fileRetention' ? 'retention-mismatch' : 'legal-hold-mismatch',
    ])
    expect(reused).toEqual([])
    const unfinished = await hiddenClient.raw.listUnfinishedLargeFiles(
      hiddenClient.accountInfo.getApiUrl(),
      hiddenClient.accountInfo.getAuthToken(),
      { bucketId: hiddenBucket.id },
    )
    expect(unfinished.files.map((file) => file.fileId)).toContain(start.fileId)
  })

  it('fails closed when high-level resume cannot read bucket default retention', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    const inner = sim.transport()
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const response = await inner.send(req)
        if (!req.url.includes('b2_list_buckets')) return response
        const body = await response.json<{
          buckets: Array<Record<string, unknown>>
        }>()
        return jsonResponse({
          ...body,
          buckets: body.buckets.map((bucket) => ({
            ...bucket,
            fileLockConfiguration: {
              isClientAuthorizedToRead: false,
              value: null,
            },
          })),
        })
      },
    }
    const hiddenDefaultClient = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: { maxRetries: 0 },
    })
    await hiddenDefaultClient.authorize()
    const hiddenDefaultBucket = await hiddenDefaultClient.createBucket({
      bucketName: 'resume-unreadable-default',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const auto = await hiddenDefaultClient.raw.startLargeFile(
      hiddenDefaultClient.accountInfo.getApiUrl(),
      hiddenDefaultClient.accountInfo.getAuthToken(),
      {
        bucketId: hiddenDefaultBucket.id,
        fileName: 'unreadable-default-auto.bin',
        contentType: 'application/octet-stream',
      },
    )
    const explicit = await hiddenDefaultClient.raw.startLargeFile(
      hiddenDefaultClient.accountInfo.getApiUrl(),
      hiddenDefaultClient.accountInfo.getAuthToken(),
      {
        bucketId: hiddenDefaultBucket.id,
        fileName: 'unreadable-default-explicit.bin',
        contentType: 'application/octet-stream',
      },
    )

    const rejected: string[] = []
    const result = await hiddenDefaultBucket.upload({
      fileName: 'unreadable-default-auto.bin',
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 1,
      resume: true,
      onResumeCandidateRejected: (event) => rejected.push(event.reason),
    })

    expect(result.fileName).toBe('unreadable-default-auto.bin')
    expect(rejected).toEqual(['retention-mismatch'])
    await expect(
      hiddenDefaultBucket.file('unreadable-default-explicit.bin').upload({
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        concurrency: 1,
        resumeFileId: explicit.fileId,
      }),
    ).rejects.toBeInstanceOf(ResumeFileIdMismatchError)
    const unfinished = await hiddenDefaultClient.raw.listUnfinishedLargeFiles(
      hiddenDefaultClient.accountInfo.getApiUrl(),
      hiddenDefaultClient.accountInfo.getAuthToken(),
      { bucketId: hiddenDefaultBucket.id },
    )
    expect(unfinished.files.map((file) => file.fileId)).toEqual(
      expect.arrayContaining([auto.fileId, explicit.fileId]),
    )
  })

  it('fails high-level resume when fresh bucket defaults cannot be fetched', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const deletedBucket = await client.createBucket({
      bucketName: 'deleted-bucket-resume',
      bucketType: BucketType.AllPrivate,
    })
    const deletedObjectBucket = await client.createBucket({
      bucketName: 'deleted-object-resume',
      bucketType: BucketType.AllPrivate,
    })
    const deletedObject = deletedObjectBucket.file('deleted-object.bin')

    await deletedBucket.delete()
    await deletedObjectBucket.delete()

    await expect(
      deletedBucket.upload({
        fileName: 'deleted-bucket.bin',
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        resume: true,
      }),
    ).rejects.toThrow(`Bucket ${deletedBucket.id} not found`)
    await expect(
      deletedObject.upload({
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        resume: true,
      }),
    ).rejects.toThrow(`Bucket ${deletedObjectBucket.id} not found`)
  })

  it('resumes unfinished files that inherited the bucket default SSE-B2 setting', async () => {
    const sseBucket = await client.createBucket({
      bucketName: 'resume-default-sse-b2',
      bucketType: BucketType.AllPrivate,
      defaultServerSideEncryption: {
        mode: EncryptionMode.SseB2,
        algorithm: EncryptionAlgorithm.Aes256,
      },
    })
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const start = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: sseBucket.id,
        fileName: 'default-sse-auto.bin',
        contentType: 'application/octet-stream',
      },
    )
    expect(start.serverSideEncryption).toEqual({
      mode: EncryptionMode.SseB2,
      algorithm: EncryptionAlgorithm.Aes256,
    })

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: start.fileId },
    )
    const part1 = data.slice(0, partSize)
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1.byteLength,
        contentSha1: await sha1Hex(part1),
      },
      part1,
    )

    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: sseBucket.id,
      fileName: 'default-sse-auto.bin',
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 1,
      resume: true,
    })

    const explicit = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: sseBucket.id,
        fileName: 'default-sse-explicit.bin',
        contentType: 'application/octet-stream',
      },
    )
    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: sseBucket.id,
      fileName: 'default-sse-explicit.bin',
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 1,
      resumeFileId: explicit.fileId,
    })

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: sseBucket.id },
    )
    const unfinishedIds = unfinished.files.map((file) => file.fileId)
    expect(unfinishedIds).not.toContain(start.fileId)
    expect(unfinishedIds).not.toContain(explicit.fileId)
  })

  it('high-level resume rejects candidates weaker than current bucket defaults', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const originalBucket = await client.createBucket({
      bucketName: 'resume-current-defaults',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const autoNoEncryption = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: originalBucket.id,
        fileName: 'default-auto.bin',
        contentType: 'application/octet-stream',
      },
    )
    const autoNoRetention = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: originalBucket.id,
        fileName: 'default-auto.bin',
        contentType: 'application/octet-stream',
        serverSideEncryption: {
          mode: EncryptionMode.SseB2,
          algorithm: EncryptionAlgorithm.Aes256,
        },
      },
    )
    const explicitNoRetention = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: originalBucket.id,
        fileName: 'default-explicit.bin',
        contentType: 'application/octet-stream',
        serverSideEncryption: {
          mode: EncryptionMode.SseB2,
          algorithm: EncryptionAlgorithm.Aes256,
        },
      },
    )

    await originalBucket.update({
      defaultServerSideEncryption: {
        mode: EncryptionMode.SseB2,
        algorithm: EncryptionAlgorithm.Aes256,
      },
      defaultRetention: {
        mode: BucketRetentionMode.Governance,
        period: { duration: 1, unit: 'days' },
      },
    })
    const rejected: string[] = []
    const result = await originalBucket.upload({
      fileName: 'default-auto.bin',
      source: new BufferSource(data),
      contentType: 'application/octet-stream',
      partSize,
      concurrency: 1,
      resume: true,
      onResumeCandidateRejected: (event) => rejected.push(event.reason),
    })

    expect(result.serverSideEncryption).toEqual({
      mode: EncryptionMode.SseB2,
      algorithm: EncryptionAlgorithm.Aes256,
    })
    expect(result.fileRetention.value?.mode).toBe(RetentionMode.Governance)
    expect(rejected).toEqual(expect.arrayContaining(['retention-mismatch', 'encryption-mismatch']))
    await expect(
      originalBucket.file('default-explicit.bin').upload({
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        concurrency: 1,
        resumeFileId: explicitNoRetention.fileId,
      }),
    ).rejects.toBeInstanceOf(ResumeFileIdMismatchError)

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: originalBucket.id },
    )
    const unfinishedIds = unfinished.files.map((file) => file.fileId)
    expect(unfinishedIds).toEqual(
      expect.arrayContaining([autoNoEncryption.fileId, autoNoRetention.fileId]),
    )
  })

  it('leaves reused unfinished files available after local upload failures', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 500,
      code: 'internal_error',
      message: 'simulated reused upload failure',
    })

    for (const mode of ['auto', 'explicit'] as const) {
      const fileName = `reused-failure-${mode}.bin`
      const start = await client.raw.startLargeFile(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        {
          bucketId: bucketId as never,
          fileName,
          contentType: 'application/octet-stream',
        },
      )

      await expect(
        uploadLargeFile(client.raw, client.accountInfo, {
          bucketId: bucketId as never,
          fileName,
          source: new BufferSource(data),
          contentType: 'application/octet-stream',
          partSize,
          concurrency: 1,
          retry: { maxRetries: 0 },
          ...(mode === 'auto' ? { resume: true } : { resumeFileId: start.fileId }),
        }),
      ).rejects.toThrow(/simulated reused upload failure/)

      const unfinished = await client.raw.listUnfinishedLargeFiles(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucketId as never },
      )
      expect(unfinished.files.map((file) => file.fileId)).toContain(start.fileId)
    }
  })

  it('keeps caller fileInfo untouched when resume is enabled', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const fileInfo = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`key_${index}`, `value_${index}`]),
    )

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-fileinfo-budget.bin',
      source: new BufferSource(data),
      fileInfo,
      partSize,
      concurrency: 1,
      resume: true,
      onResumeCandidateRejected: () => {},
    })

    expect(result.fileInfo).toEqual(fileInfo)
  })

  it('uses empty fileInfo with custom resume discovery limits', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'resume-empty-fileinfo.bin',
      source: new BufferSource(data),
      partSize,
      concurrency: 1,
      resume: true,
      resumeMaxListPages: 3,
      resumeMaxPartCandidates: 4,
      resumeMaxPartPages: 5,
      onResumeCandidateRejected: () => {},
    })

    expect(result.fileInfo).toEqual({})
  })

  it('skips a same-name unfinished upload with conflicting resume identity', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2 + 7)
    const conflictData = deterministicBytes(partSize * 2 + 9)
    const contentType = 'application/octet-stream'

    const conflict = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'same-name.bin',
        contentType,
        fileInfo: { origin: 'conflict' },
      },
    )
    const matching = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'same-name.bin',
        contentType,
        fileInfo: { origin: 'match' },
      },
    )

    for (const [fileId, bytes] of [
      [conflict.fileId, conflictData],
      [matching.fileId, data],
    ] as const) {
      const partUrl = await client.raw.getUploadPartUrl(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { fileId },
      )
      const part1 = bytes.slice(0, partSize)
      await client.raw.uploadPart(
        partUrl.uploadUrl,
        {
          authorization: partUrl.authorizationToken,
          partNumber: 1,
          contentLength: part1.byteLength,
          contentSha1: await sha1Hex(part1),
        },
        part1,
      )
    }

    const reused: ResumePartReusedEvent[] = []
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'same-name.bin',
      source: new BufferSource(data),
      contentType,
      fileInfo: { origin: 'match' },
      partSize,
      concurrency: 1,
      resume: true,
      onResumePartReused: (event) => reused.push(event),
    })

    expect(result.fileName).toBe('same-name.bin')
    expect(result.contentLength).toBe(data.byteLength)
    expect(reused).toEqual([])

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucketId as never },
    )
    const unfinishedIds = unfinished.files.map((file) => file.fileId)
    expect(unfinishedIds).toContain(conflict.fileId)
    expect(unfinishedIds).not.toContain(matching.fileId)
  })

  it('reuploads a same-length tampered resume part when SHA-1 differs', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const tampered = data.slice(0, partSize)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    const contentType = 'application/octet-stream'
    const fileInfo = { origin: 'match' }
    const candidate = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'tampered-resume.bin',
        contentType,
        fileInfo,
      },
    )

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: candidate.fileId },
    )
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: tampered.byteLength,
        contentSha1: await sha1Hex(tampered),
      },
      tampered,
    )

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'tampered-resume.bin',
      source: new BufferSource(data),
      contentType,
      fileInfo,
      partSize,
      concurrency: 1,
      resume: true,
    })

    expect(result.fileName).toBe('tampered-resume.bin')
    const downloaded = await bucket.download('tampered-resume.bin')
    expect(await readStream(downloaded.body)).toEqual(data)
  })

  it('reuploads automatic resume parts even when an unfinished part has matching SHA-1', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const sim = new B2Simulator({ minimumPartSize: partSize, recommendedPartSize: partSize })
    const inner = sim.transport()
    let countResumeUploads = false
    let resumeUploadPartAttempts = 0
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (countResumeUploads && req.url.includes('b2_upload_part?')) {
          resumeUploadPartAttempts += 1
        }
        return inner.send(req)
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
      bucketName: 'auto-resume-reuploads',
      bucketType: BucketType.AllPrivate,
    })
    const fileName = 'auto-reupload-matching.bin'
    const contentType = 'application/octet-stream'
    const fileInfo = { owner: 'caller' }
    const candidate = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName,
        contentType,
        fileInfo,
      },
    )
    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: candidate.fileId },
    )
    const part1 = data.slice(0, partSize)
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1.byteLength,
        contentSha1: await sha1Hex(part1),
      },
      part1,
    )

    const reused: ResumePartReusedEvent[] = []
    countResumeUploads = true
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName,
      source: new BufferSource(data),
      contentType,
      fileInfo,
      partSize,
      concurrency: 1,
      resume: true,
      onResumePartReused: (event) => reused.push(event),
    })

    expect(result.fileName).toBe(fileName)
    expect(reused).toEqual([])
    expect(resumeUploadPartAttempts).toBe(2)
    const downloaded = await bucket.download(fileName)
    expect(await readStream(downloaded.body)).toEqual(data)
  })

  it('starts a new upload instead of auto-resuming SSE-C candidates', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const contentType = 'application/octet-stream'
    const first = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'sse-c.bin',
        contentType,
        serverSideEncryption: sseCustomer('key-a', 'md5-a'),
      },
    )
    const second = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'sse-c.bin',
        contentType,
        serverSideEncryption: sseCustomer('key-b', 'md5-b'),
      },
    )
    expect(first.serverSideEncryption).not.toHaveProperty('customerKey')
    expect(first.serverSideEncryption).not.toHaveProperty('customerKeyMd5')
    expect(JSON.stringify(first)).not.toContain('key-a')
    expect(JSON.stringify(first)).not.toContain('md5-a')
    expect(JSON.stringify(second)).not.toContain('key-b')
    expect(JSON.stringify(second)).not.toContain('md5-b')

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: first.fileId },
    )
    const part = data.slice(0, partSize)
    const uploaded = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part.byteLength,
        contentSha1: await sha1Hex(part),
        serverSideEncryption: sseCustomer('key-a', 'md5-a'),
      },
      part,
    )
    expect(uploaded.serverSideEncryption).not.toHaveProperty('customerKey')
    expect(uploaded.serverSideEncryption).not.toHaveProperty('customerKeyMd5')
    expect(JSON.stringify(uploaded)).not.toContain('key-a')
    expect(JSON.stringify(uploaded)).not.toContain('md5-a')

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucketId as never,
      fileName: 'sse-c.bin',
      source: new BufferSource(data),
      contentType,
      partSize,
      concurrency: 1,
      resume: true,
      serverSideEncryption: sseCustomer('key-c', 'md5-c'),
      onResumeCandidateRejected: () => {},
    })

    expect(result.fileName).toBe('sse-c.bin')
    expect(result.serverSideEncryption).not.toHaveProperty('customerKey')
    expect(result.serverSideEncryption).not.toHaveProperty('customerKeyMd5')
    expect(JSON.stringify(result)).not.toContain('key-c')
    expect(JSON.stringify(result)).not.toContain('md5-c')
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucketId as never },
    )
    const unfinishedIds = unfinished.files.map((file) => file.fileId)
    expect(unfinishedIds).toContain(first.fileId)
    expect(unfinishedIds).toContain(second.fileId)
    expect(unfinished.files[0]?.serverSideEncryption).not.toHaveProperty('customerKey')
    expect(unfinished.files[0]?.serverSideEncryption).not.toHaveProperty('customerKeyMd5')
    expect(JSON.stringify(unfinished)).not.toContain('key-a')
    expect(JSON.stringify(unfinished)).not.toContain('md5-a')
    expect(JSON.stringify(unfinished)).not.toContain('key-b')
    expect(JSON.stringify(unfinished)).not.toContain('md5-b')
  })

  it('rejects SSE-C resumeFileId even when all parts are present', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const contentType = 'application/octet-stream'
    const startEncryption = sseCustomer('key-a', 'md5-a')
    const start = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'explicit-sse-c.bin',
        contentType,
        serverSideEncryption: startEncryption,
      },
    )

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: start.fileId },
    )
    for (const partNumber of [1, 2]) {
      const offset = (partNumber - 1) * partSize
      const part = data.slice(offset, offset + partSize)
      await client.raw.uploadPart(
        partUrl.uploadUrl,
        {
          authorization: partUrl.authorizationToken,
          partNumber,
          contentLength: part.byteLength,
          contentSha1: await sha1Hex(part),
          serverSideEncryption: startEncryption,
        },
        part,
      )
    }

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucketId as never,
        fileName: 'explicit-sse-c.bin',
        source: new BufferSource(data),
        contentType,
        partSize,
        concurrency: 1,
        resumeFileId: start.fileId,
        serverSideEncryption: sseCustomer('key-b', 'md5-b'),
      }),
    ).rejects.toBeInstanceOf(ResumeFileIdMismatchError)

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucketId as never },
    )
    expect(unfinished.files.map((file) => file.fileId)).toContain(start.fileId)
    await expect(bucket.download('explicit-sse-c.bin')).rejects.toThrow(/HTTP 404/)
  })

  it('rejects an explicit resumeFileId that targets a different file name', async () => {
    const partSize = 100_000
    const data = deterministicBytes(partSize * 2)
    const rejected: Array<{
      fileId?: string
      requestedFileName: string
      candidateFileName?: string
      reason: string
    }> = []
    const foreign = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucketId as never,
        fileName: 'foreign.bin',
        contentType: 'application/octet-stream',
      },
    )

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucketId as never,
        fileName: 'wanted.bin',
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
        partSize,
        concurrency: 1,
        resumeFileId: foreign.fileId,
        onResumeCandidateRejected: (event) => rejected.push(event),
      }),
    ).rejects.toThrow(ResumeFileIdMismatchError)

    expect(rejected).toEqual([])

    const parts = await client.raw.listParts(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: foreign.fileId },
    )
    expect(parts.parts).toEqual([])
  })
})

describe('uploadLargeFile control-plane aborts', () => {
  it('passes the caller signal to stalled startLargeFile requests', async () => {
    const controller = new AbortController()
    let startSignal: AbortSignal | undefined
    const raw = {
      startLargeFile(...args: Parameters<RawClient['startLargeFile']>) {
        startSignal = args[3]?.signal
        return rejectOnAbort(args[3]?.signal, 'start aborted')
      },
    } as unknown as RawClient

    const upload = uploadLargeFile(raw, makeMultipartAccountInfo(), {
      bucketId: bucketId('bucket'),
      fileName: 'start-abort.bin',
      source: new BufferSource(deterministicBytes(4)),
      partSize: 2,
      signal: controller.signal,
    })
    controller.abort(new Error('start aborted'))

    await expect(upload).rejects.toThrow('start aborted')
    expect(startSignal).toBe(controller.signal)
  })

  it('passes the abort-scope signal to stalled finishLargeFile requests', async () => {
    const controller = new AbortController()
    const finishStarted = Promise.withResolvers<void>()
    let finishSignal: AbortSignal | undefined
    let cancelSignal: AbortSignal | undefined
    const raw = {
      startLargeFile: async () => ({ fileId: largeFileId('finish-large') }),
      uploadPart: async (_uploadUrl: string, headers: Parameters<RawClient['uploadPart']>[1]) => ({
        fileId: largeFileId('finish-large'),
        partNumber: headers.partNumber,
        contentLength: headers.contentLength,
        contentSha1: headers.contentSha1,
        uploadTimestamp: Date.now(),
      }),
      finishLargeFile(...args: Parameters<RawClient['finishLargeFile']>) {
        finishSignal = args[3]?.signal
        finishStarted.resolve()
        return rejectOnAbort(args[3]?.signal, 'finish aborted')
      },
      cancelLargeFile(...args: Parameters<RawClient['cancelLargeFile']>) {
        cancelSignal = args[3]?.signal
        return Promise.resolve({
          fileId: largeFileId('finish-large'),
          accountId: 'account',
          bucketId: bucketId('bucket'),
          fileName: 'finish-abort.bin',
        })
      },
    } as unknown as RawClient

    const upload = uploadLargeFile(raw, makeMultipartAccountInfo(), {
      bucketId: bucketId('bucket'),
      fileName: 'finish-abort.bin',
      source: new BufferSource(deterministicBytes(4)),
      partSize: 2,
      concurrency: 1,
      signal: controller.signal,
    })
    await finishStarted.promise
    controller.abort(new Error('finish aborted'))

    await expect(upload).rejects.toThrow('finish aborted')
    expect(finishSignal?.aborted).toBe(true)
    expect(cancelSignal?.aborted).toBe(false)
  })

  it('uses an independent cleanup signal after multipart scope aborts', async () => {
    let cancelSignal: AbortSignal | undefined
    const raw = {
      startLargeFile: async () => ({ fileId: largeFileId('cleanup-large') }),
      uploadPart: async () => {
        throw new Error('part failed')
      },
      cancelLargeFile(...args: Parameters<RawClient['cancelLargeFile']>) {
        cancelSignal = args[3]?.signal
        return Promise.resolve({
          fileId: largeFileId('cleanup-large'),
          accountId: 'account',
          bucketId: bucketId('bucket'),
          fileName: 'cleanup-abort.bin',
        })
      },
    } as unknown as RawClient

    await expect(
      uploadLargeFile(raw, makeMultipartAccountInfo(), {
        bucketId: bucketId('bucket'),
        fileName: 'cleanup-abort.bin',
        source: new BufferSource(deterministicBytes(4)),
        partSize: 2,
        concurrency: 1,
      }),
    ).rejects.toThrow('part failed')

    expect(cancelSignal?.aborted).toBe(false)
  })

  it('rejects an unknown explicit resumeFileId before inspecting or uploading parts', async () => {
    const partSize = 100_000
    const listParts = vi.spyOn(client.raw, 'listParts')
    const uploadPart = vi.spyOn(client.raw, 'uploadPart')
    const finishLargeFile = vi.spyOn(client.raw, 'finishLargeFile')

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucketId as never,
        fileName: 'unknown-resume.bin',
        source: new BufferSource(deterministicBytes(partSize * 2)),
        partSize,
        concurrency: 1,
        resumeFileId: '4_z_unknown' as never,
      }),
    ).rejects.toThrow(/resumeFileId does not match/)

    expect(listParts).not.toHaveBeenCalled()
    expect(uploadPart).not.toHaveBeenCalled()
    expect(finishLargeFile).not.toHaveBeenCalled()
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

  it('rejects explicit resumeFileId on Bucket.upload small-file path', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'small-resume-id-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.upload({
        fileName: 'small-resume-id.txt',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        resumeFileId: largeFileId('unfinished-large-file'),
      }),
    ).rejects.toThrow(/resumeFileId is only supported for multipart uploads/)
  })

  it('rejects explicit resumeFileId on B2Object.upload small-file path', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'small-resume-id-object',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      bucket.file('small-resume-id.txt').upload({
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        resumeFileId: largeFileId('unfinished-large-file'),
      }),
    ).rejects.toThrow(/resumeFileId is only supported for multipart uploads/)
  })

  it('aborts while buffering a forward-only small-file source', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'small-forward-abort',
      bucketType: BucketType.AllPrivate,
    })
    const readStarted = deferred<void>()
    const cancel = vi.fn()
    const controller = new AbortController()
    const readable = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve()
      },
      cancel(reason) {
        cancel(reason)
      },
    })

    const upload = bucket.upload({
      fileName: 'stalled-small.bin',
      source: new StreamSource(readable, 1),
      signal: controller.signal,
    })
    await readStarted.promise
    controller.abort('stop small upload')

    await expect(upload).rejects.toBe('stop small upload')
    expect(cancel).toHaveBeenCalledWith('stop small upload')
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

  it('uploads a StreamSource with empty chunks through the sequential multipart path', async () => {
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
    // so the part-buffer assembly loop has to coalesce across reads and
    // ignore valid zero-length chunks, including after the advertised size.
    const chunkSize = 7919 // prime, doesn't divide partSize evenly
    let cursor = 0
    let emitEmpty = true
    let trailingEmptyEmitted = false
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitEmpty) {
          emitEmpty = false
          controller.enqueue(new Uint8Array(0))
          return
        }
        if (cursor >= payload.byteLength) {
          if (!trailingEmptyEmitted) {
            trailingEmptyEmitted = true
            controller.enqueue(new Uint8Array(0))
            return
          }
          controller.close()
          return
        }
        const end = Math.min(cursor + chunkSize, payload.byteLength)
        controller.enqueue(payload.subarray(cursor, end))
        cursor = end
        emitEmpty = true
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

  it('rejects too many consecutive empty chunks in a streaming multipart source', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-empty-spin',
      bucketType: BucketType.AllPrivate,
    })

    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(0))
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'empty-spin.bin',
        source: new StreamSource(readable, 100_000),
        partSize: 100_000,
      }),
    ).rejects.toThrow('source stream emitted more than 1024 consecutive empty chunks')
    expect(await bucket.getFileInfoByName('empty-spin.bin')).toBeNull()
  })

  it('rejects a streaming multipart source that ends before its advertised size', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-short',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize + 7)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'short.bin',
        source: new StreamSource(readable, payload.byteLength + 1),
        partSize,
      }),
    ).rejects.toThrow(
      `uploadLargeFile: source stream ended after ${payload.byteLength} bytes, expected ${payload.byteLength + 1}.`,
    )
    expect(await bucket.getFileInfoByName('short.bin')).toBeNull()
  })

  it('rejects a streaming multipart source that emits more than its advertised size', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-long',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const advertisedSize = partSize + 7
    const payload = deterministicBytes(advertisedSize + 1)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'long.bin',
        source: new StreamSource(readable, advertisedSize),
        partSize,
      }),
    ).rejects.toThrow(
      `uploadLargeFile: source stream emitted more than advertised ${advertisedSize} bytes.`,
    )
    expect(await bucket.getFileInfoByName('long.bin')).toBeNull()
  })

  it('cancels a streaming multipart source when the upload aborts', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-abort-cancel',
      bucketType: BucketType.AllPrivate,
    })

    const controller = new AbortController()
    const reason = new Error('stop streaming upload')
    controller.abort(reason)
    let cancelReason: unknown
    const readable = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(deterministicBytes(100_000))
      },
      cancel(value) {
        cancelReason = value
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucket.id,
        fileName: 'abort-stream.bin',
        source: new StreamSource(readable, 100_000),
        partSize: 100_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason)
    expect(cancelReason).toBe(reason)
    expect(await bucket.getFileInfoByName('abort-stream.bin')).toBeNull()
  })

  it('cancels a pending streaming multipart read when the upload aborts', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-pending-abort',
      bucketType: BucketType.AllPrivate,
    })

    const controller = new AbortController()
    const reason = new Error('stop pending streaming upload')
    let resolvePullStarted!: () => void
    const pullStarted = new Promise<void>((resolve) => {
      resolvePullStarted = resolve
    })
    let resolvePull!: () => void
    const pendingPull = new Promise<void>((resolve) => {
      resolvePull = resolve
    })
    let cancelReason: unknown
    const readable = new ReadableStream<Uint8Array>({
      pull() {
        resolvePullStarted()
        return pendingPull
      },
      cancel(value) {
        cancelReason = value
        resolvePull()
      },
    })

    const uploadPromise = uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'pending-abort-stream.bin',
      source: new StreamSource(readable, 100_000),
      partSize: 100_000,
      signal: controller.signal,
    })

    await pullStarted
    controller.abort(reason)

    await expect(uploadPromise).rejects.toBe(reason)
    expect(cancelReason).toBe(reason)
    expect(await bucket.getFileInfoByName('pending-abort-stream.bin')).toBeNull()
  })

  it('rejects resumeFileId on streaming sources before listing parts', async () => {
    const { client } = makeSmallPartClient()
    await client.authorize()
    const listParts = vi.spyOn(client.raw, 'listParts')
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })

    await expect(
      uploadLargeFile(client.raw, client.accountInfo, {
        bucketId: bucketId('bucket'),
        fileName: 'stream-resume.bin',
        source: new StreamSource(readable, 100_000),
        partSize: 100_000,
        resumeFileId: largeFileId('unfinished-large-file'),
      }),
    ).rejects.toThrow('resume is not supported on non-sliceable sources')
    expect(listParts).not.toHaveBeenCalled()
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

  it('cancels an async iterable source when sequential multipart upload fails', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    sim.injectFailure({
      on: 'b2_upload_part?fileId=',
      status: 400,
      code: 'bad_request',
      message: 'simulated async iterable upload_part failure',
    })
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'async-iterable-fail',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const chunk = deterministicBytes(25_000)
    const totalSize = partSize * 2
    let returned = false
    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: chunk }
          },
          async return() {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }

    await expect(
      bucket.upload({
        fileName: 'async-iterable-boom.bin',
        source: toContentSource(iterable, totalSize),
        partSize,
      }),
    ).rejects.toThrow(/simulated async iterable upload_part failure/)

    expect(returned).toBe(true)
  })

  it('rejects a forward-only source that emits more bytes than advertised', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-extra-bytes',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const payload = deterministicBytes(partSize + 10)
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-extra.bin',
        source: new StreamSource(readable, partSize + 1),
        partSize,
      }),
    ).rejects.toThrow(/emitted more bytes than advertised size/)

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'stream-extra.bin')).toBeUndefined()
  })

  it('rejects extra forward-only bytes after an exact planned boundary', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-extra-boundary',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(deterministicBytes(partSize))
        controller.enqueue(deterministicBytes(partSize).reverse())
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-extra-boundary.bin',
        source: new StreamSource(readable, partSize * 2),
        partSize,
      }),
    ).rejects.toThrow(/emitted more bytes than advertised size/)
  })

  it('accepts trailing empty forward-only chunks after advertised bytes', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-trailing-empty',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const first = deterministicBytes(partSize)
    const second = deterministicBytes(partSize).reverse()
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first)
        controller.enqueue(second)
        controller.enqueue(new Uint8Array(0))
        controller.enqueue(new Uint8Array(0))
        controller.close()
      },
    })

    const result = await bucket.upload({
      fileName: 'stream-trailing-empty.bin',
      source: new StreamSource(readable, partSize * 2),
      partSize,
    })

    expect(result.contentLength).toBe(partSize * 2)
    const downloaded = await bucket.download('stream-trailing-empty.bin')
    const bytes = await readStream(downloaded.body)
    const expected = new Uint8Array(partSize * 2)
    expected.set(first)
    expected.set(second, partSize)
    expect(bytes).toEqual(expected)
  })

  it('rejects unbounded trailing empty forward-only chunks after advertised bytes', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-empty-trailer-poison',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    let cancelled = false
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(deterministicBytes(partSize))
        controller.enqueue(deterministicBytes(partSize).reverse())
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(0))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-empty-trailer-poison.bin',
        source: new StreamSource(readable, partSize * 2),
        partSize,
      }),
    ).rejects.toThrow(/too many empty chunks/)

    expect(cancelled).toBe(true)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(
      unfinished.files.find((f) => f.fileName === 'stream-empty-trailer-poison.bin'),
    ).toBeUndefined()
  })

  it('rejects unbounded empty forward-only chunks before data', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-empty-before-poison',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    let cancelled = false
    const readable = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(0))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-empty-before-poison.bin',
        source: new StreamSource(readable, partSize * 2),
        partSize,
      }),
    ).rejects.toThrow(/too many empty chunks/)

    expect(cancelled).toBe(true)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(
      unfinished.files.find((f) => f.fileName === 'stream-empty-before-poison.bin'),
    ).toBeUndefined()
  })

  it('rejects unbounded empty forward-only chunks between parts', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-empty-between-poison',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    let cancelled = false
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(deterministicBytes(partSize))
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(0))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(
      bucket.upload({
        fileName: 'stream-empty-between-poison.bin',
        source: new StreamSource(readable, partSize * 2),
        partSize,
      }),
    ).rejects.toThrow(/too many empty chunks/)

    expect(cancelled).toBe(true)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(
      unfinished.files.find((f) => f.fileName === 'stream-empty-between-poison.bin'),
    ).toBeUndefined()
  })

  it('aborts a stalled forward-only multipart read', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-read-abort',
      bucketType: BucketType.AllPrivate,
    })

    const partSize = 100_000
    const controller = new AbortController()
    const readStarted = Promise.withResolvers<void>()
    let cancelled = false
    const readable = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve()
        return new Promise<never>(() => {})
      },
      cancel() {
        cancelled = true
      },
    })

    const upload = uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'stream-read-abort.bin',
      source: new StreamSource(readable, partSize),
      partSize,
      concurrency: 1,
      signal: controller.signal,
    })

    await readStarted.promise
    controller.abort(new Error('stop stalled stream'))

    await expect(upload).rejects.toThrow('stop stalled stream')
    expect(cancelled).toBe(true)
    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((f) => f.fileName === 'stream-read-abort.bin')).toBeUndefined()
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

    const listUnfinishedLargeFiles = vi.spyOn(client.raw, 'listUnfinishedLargeFiles')
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
    expect(listUnfinishedLargeFiles).not.toHaveBeenCalled()
  })

  it('does not cancel a pre-existing unfinished file for stream resume misuse', async () => {
    const { client } = makeClient({ minimumPartSize: 100_000, recommendedPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'stream-resume-preserve',
      bucketType: BucketType.AllPrivate,
    })

    const started = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'resume-stream-preserve.bin',
        contentType: 'b2/x-auto',
      },
    )

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
        fileName: 'resume-stream-preserve.bin',
        source: new StreamSource(readable, payload.byteLength),
        partSize,
        concurrency: 1,
        resumeFileId: started.fileId,
      }),
    ).rejects.toThrow(/resume is not supported on non-sliceable sources/)

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files.find((file) => file.fileId === started.fileId)).toBeDefined()
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
