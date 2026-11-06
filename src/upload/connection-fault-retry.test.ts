import { describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import { B2SsrfError, NetworkError, UploadResponseBodyError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { FetchTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { daysFromNow, jsonErrorResponse, jsonResponse, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { RetentionMode } from '../types/lock.ts'
import { withFreshUploadUrlRetry } from './retry.ts'
import { uploadSmallFile } from './single.ts'

type Failure =
  | 'connection'
  | 'type-error'
  | 'timeout'
  | '503'
  | 'auth'
  | 'url'
  | 'url-fetch'
  | 'later-url-fetch'
  | 'body'
  | 'part'

async function harness(clientDefault?: boolean, failure: Failure = 'connection') {
  const sim = new B2Simulator({ minimumPartSize: 4, recommendedPartSize: 4 })
  const inner = sim.transport()
  const fault = new NetworkError('connection dropped after the POST was stored')
  const stats = { files: 0, parts: 0, urls: 0, partUrls: 0, fileUrls: [] as string[] }
  async function sendFile(request: HttpRequest): Promise<HttpResponse> {
    stats.files++
    stats.fileUrls.push(request.url)
    if (stats.files === 1) {
      if (failure === '503' || failure === 'later-url-fetch') {
        return jsonErrorResponse(503, 'service_unavailable', 'temporary server failure')
      }
      if (failure === 'auth')
        return jsonErrorResponse(401, 'bad_auth_token', 'expired upload token')
      if (failure === 'url') return jsonErrorResponse(400, 'bad_request', 'invalid upload url')
    }
    const response = await inner.send(request)
    if (stats.files !== 1) return response
    if (failure === 'connection') throw fault
    if (failure === 'type-error') throw new TypeError('socket closed')
    if (failure === 'timeout') throw new DOMException('socket timed out', 'TimeoutError')
    if (failure === 'body')
      return {
        ...response,
        json: async <T>(): Promise<T> => {
          throw new TypeError('success body lost')
        },
      }
    return response
  }
  const transport: HttpTransport = {
    async send(request) {
      if (request.url.includes('b2_get_upload_url')) {
        stats.urls++
        if (
          (failure === 'url-fetch' && stats.urls === 1) ||
          (failure === 'later-url-fetch' && stats.urls === 2)
        )
          throw fault
        const response = await inner.send(request)
        const body = await response.json<{ uploadUrl: string }>()
        return jsonResponse({ ...body, uploadUrl: `${body.uploadUrl}&testAttempt=${stats.urls}` })
      }
      if (request.url.includes('b2_get_upload_part_url')) stats.partUrls++
      if (request.url.includes('b2_upload_file?')) {
        return sendFile(request)
      }
      if (request.url.includes('b2_upload_part?')) {
        stats.parts++
        const response = await inner.send(request)
        if (failure === 'part' && stats.parts === 1) throw fault
        return response
      }
      return inner.send(request)
    },
  }
  const client = new B2Client({
    applicationKeyId: 'test-key',
    applicationKey: 'test-key',
    transport,
    retry: { maxRetries: 2, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    ...(clientDefault !== undefined ? { retryUploadConnectionFaults: clientDefault } : {}),
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'connection-optout',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket, stats, fault }
}

describe('single-file connection-fault retry policy', () => {
  for (const facade of ['bucket', 'file'] as const) {
    it.each([
      { name: 'default on', clientValue: undefined, callValue: undefined, retries: true },
      { name: 'explicit client true', clientValue: true, callValue: undefined, retries: true },
      { name: 'client false', clientValue: false, callValue: undefined, retries: false },
      { name: 'per-call false', clientValue: undefined, callValue: false, retries: false },
      {
        name: 'per-call false overrides true',
        clientValue: true,
        callValue: false,
        retries: false,
      },
      { name: 'per-call true overrides false', clientValue: false, callValue: true, retries: true },
    ])(`${facade}: $name`, async (scenario) => {
      const { client, bucket, stats, fault } = await harness(scenario.clientValue)
      let retryEvents = 0
      const options = {
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        onUploadRetry: () => {
          retryEvents++
        },
        ...(scenario.callValue !== undefined
          ? { retryUploadConnectionFaults: scenario.callValue }
          : {}),
      }
      const listedBucket = await client.getBucket(bucket.name)
      if (listedBucket === null) throw new Error('fixture bucket missing')
      const upload =
        facade === 'bucket'
          ? bucket.upload({ ...options, fileName: 'data.bin' })
          : listedBucket.file('data.bin').upload(options)
      if (scenario.retries) await upload
      else await expect(upload).rejects.toBe(fault)

      expect(stats.files).toBe(scenario.retries ? 2 : 1)
      expect(stats.urls).toBe(scenario.retries ? 2 : 1)
      expect(retryEvents).toBe(scenario.retries ? 1 : 0)
      const versions = await bucket.listFileVersions({ prefix: 'data.bin' })
      expect(versions.files).toHaveLength(scenario.retries ? 2 : 1)
      const downloaded = await bucket.download('data.bin')
      expect(await readStream(downloaded.body)).toEqual(new Uint8Array([1, 2, 3]))
    })
  }

  it.each([
    { name: 'default', value: undefined, retries: true },
    { name: 'explicit true', value: true, retries: true },
    { name: 'opt-out', value: false, retries: false },
  ])('direct small-file helper: $name', async (scenario) => {
    const { client, bucket, stats, fault } = await harness()
    const upload = uploadSmallFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'direct.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
      ...(scenario.value !== undefined ? { retryUploadConnectionFaults: scenario.value } : {}),
      retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    if (scenario.retries) await upload
    else await expect(upload).rejects.toBe(fault)
    expect(stats.files).toBe(scenario.retries ? 2 : 1)
  })

  it('does not create a second version in an Object Lock-enabled bucket', async () => {
    const { client, stats, fault } = await harness(false)
    const locked = await client.createBucket({
      bucketName: 'locked-optout',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const retention = { mode: RetentionMode.Compliance, retainUntilTimestamp: daysFromNow(1) }
    const uploadFile = vi.spyOn(client.raw, 'uploadFile')
    await expect(
      locked.upload({
        fileName: 'locked.bin',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        fileRetention: retention,
      }),
    ).rejects.toBe(fault)
    expect(stats.files).toBe(1)
    const versions = await locked.listFileVersions({ prefix: 'locked.bin' })
    expect(versions.files).toHaveLength(1)
    expect(locked.info.fileLockConfiguration.value?.isFileLockEnabled).toBe(true)
    // The simulator does not persist single-file retention headers. Pin the
    // outgoing contract here without claiming server-side retention enforcement.
    expect(uploadFile.mock.calls[0]?.[1].fileRetention).toEqual(retention)
  })

  it.each(['type-error', 'timeout'] as const)('does not replay a wrapped %s', async (failure) => {
    const { bucket, stats } = await harness(false, failure)
    await expect(
      bucket.upload({
        fileName: 'wrapped.bin',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
      }),
    ).rejects.toBeInstanceOf(NetworkError)
    expect(stats.files).toBe(1)
    expect((await bucket.listFileVersions({ prefix: 'wrapped.bin' })).files).toHaveLength(1)
  })

  it.each(['503', 'auth', 'url'] as const)(
    'retains %s retries with connection retries disabled',
    async (failure) => {
      const { bucket, stats } = await harness(false, failure)
      let retries = 0
      await bucket.upload({
        fileName: 'recover.bin',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        onUploadRetry: () => {
          retries++
        },
      })
      expect(stats.files).toBe(2)
      expect(stats.urls).toBe(2)
      expect(stats.fileUrls[0]).not.toBe(stats.fileUrls[1])
      expect(retries).toBe(1)
      expect((await bucket.listFileVersions({ prefix: 'recover.bin' })).files).toHaveLength(1)
    },
  )

  it.each(['url-fetch', 'later-url-fetch'] as const)(
    'retains %s network recovery',
    async (failure) => {
      const { bucket, stats } = await harness(false, failure)
      let retries = 0
      await bucket.upload({
        fileName: 'url-recovery.bin',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        onUploadRetry: () => {
          retries++
        },
      })
      expect(stats.files).toBe(failure === 'url-fetch' ? 1 : 2)
      expect(stats.urls).toBe(failure === 'url-fetch' ? 2 : 3)
      expect(retries).toBe(failure === 'url-fetch' ? 1 : 2)
    },
  )

  it.each([false, true])(
    'keeps response-body replay independent: %s',
    async (retryResponseBodyFailures) => {
      const { bucket, stats } = await harness(false, 'body')
      const upload = bucket.upload({
        fileName: 'body.bin',
        source: new BufferSource(new Uint8Array([1, 2, 3])),
        retryResponseBodyFailures,
      })
      if (retryResponseBodyFailures) await upload
      else await expect(upload).rejects.toBeInstanceOf(UploadResponseBodyError)
      expect(stats.files).toBe(retryResponseBodyFailures ? 2 : 1)
      expect((await bucket.listFileVersions({ prefix: 'body.bin' })).files).toHaveLength(
        retryResponseBodyFailures ? 2 : 1,
      )
    },
  )

  it.each([false, true])(
    'keeps SSRF refusals terminal with setting %s',
    async (retryUploadConnectionFaults) => {
      const fault = new NetworkError('SSRF refused', new B2SsrfError('blocked', 'http://127.0.0.1'))
      const upload = vi.fn().mockRejectedValue(fault)
      await expect(
        withFreshUploadUrlRetry({
          fileName: 'blocked.bin',
          partNumber: null,
          retryUploadConnectionFaults,
          retryResponseBodyFailures: true,
          retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
          checkout: () => ({
            uploadUrl: 'https://upload.example/file',
            authorizationToken: 'token',
          }),
          fetchFresh: async () => ({
            uploadUrl: 'https://upload.example/fresh',
            authorizationToken: 'token',
          }),
          returnEntry: () => {},
          evictEntry: () => {},
          upload,
        }),
      ).rejects.toBe(fault)
      expect(upload).toHaveBeenCalledTimes(1)
    },
  )
})

describe('multipart retry policy remains unchanged', () => {
  it('ignores the flag in the shared part retry helper', async () => {
    const entry = { uploadUrl: 'https://upload.example/part', authorizationToken: 'token' }
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError('part connection fault'))
      .mockResolvedValue('stored')
    await expect(
      withFreshUploadUrlRetry({
        fileName: 'part.bin',
        partNumber: 1,
        retryUploadConnectionFaults: false,
        retryResponseBodyFailures: false,
        retry: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
        checkout: () => entry,
        fetchFresh: async () => entry,
        returnEntry: () => {},
        evictEntry: () => {},
        upload,
      }),
    ).resolves.toBe('stored')
    expect(upload).toHaveBeenCalledTimes(2)
  })
  it.each(['bucket', 'file', 'stream'] as const)(
    'still retries through the %s facade when disabled',
    async (facade) => {
      const { bucket, stats } = await harness(false, 'part')
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      if (facade === 'stream') {
        const handle = bucket
          .file('multipart.bin')
          .createWriteStream({ retryUploadConnectionFaults: false, partSize: 4, concurrency: 1 })
        const writer = handle.writable.getWriter()
        await writer.write(bytes)
        await writer.close()
        await handle.done
      } else {
        const options = {
          source: new BufferSource(bytes),
          partSize: 4,
          concurrency: 1,
          retryUploadConnectionFaults: false,
        }
        if (facade === 'bucket') await bucket.upload({ ...options, fileName: 'multipart.bin' })
        else await bucket.file('multipart.bin').upload(options)
      }
      expect(stats.parts).toBe(3)
      expect(stats.partUrls).toBe(2)
      expect((await bucket.listFileVersions({ prefix: 'multipart.bin' })).files).toHaveLength(1)
      expect(await readStream((await bucket.download('multipart.bin')).body)).toEqual(bytes)
    },
  )
})

describe('request timeout phases', () => {
  it.each(['headers', 'body-disabled', 'body-enabled'] as const)(
    'handles timeout during %s',
    async (phase) => {
      const sim = new B2Simulator()
      const inner = sim.transport()
      let attempts = 0
      let timedOutAfterStorage = false
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const request: HttpRequest = {
          url: input instanceof Request ? input.url : String(input),
          method: (init?.method ?? 'GET') as HttpRequest['method'],
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: init?.body ?? null,
        }
        const response = await inner.send(request)
        if (request.url.includes('b2_upload_file?') && ++attempts === 1) {
          if (phase === 'headers') {
            return new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal
              if (signal === undefined || signal === null || signal.aborted) {
                reject(new Error('expected a live timeout signal after storing the upload'))
                return
              }
              signal.addEventListener(
                'abort',
                () => {
                  timedOutAfterStorage = true
                  reject(signal.reason)
                },
                { once: true },
              )
            })
          }
          return new Response(new ReadableStream<Uint8Array>(), {
            status: response.status,
            headers: response.headers,
          })
        }
        return new Response(await response.text(), {
          status: response.status,
          headers: response.headers,
        })
      })
      try {
        const client = new B2Client({
          applicationKeyId: 'test-key',
          applicationKey: 'test-key',
          // Simulator URLs are localhost; every fetch in this fixture is mocked.
          transport: new FetchTransport({ urlGuard: new UrlGuard() }),
        })
        await client.authorize()
        const bucket = await client.createBucket({
          bucketName: 'timeout-phase',
          bucketType: BucketType.AllPrivate,
        })
        const upload = bucket.upload({
          fileName: 'timeout.bin',
          source: new BufferSource(new Uint8Array([1, 2, 3])),
          retryUploadConnectionFaults: false,
          retryResponseBodyFailures: phase !== 'body-disabled',
          retry: {
            maxRetries: 1,
            initialRetryDelayMs: 0,
            maxRetryDelayMs: 0,
            requestTimeoutMs: 100,
          },
        })
        if (phase === 'body-enabled') await upload
        else if (phase === 'body-disabled')
          await expect(upload).rejects.toBeInstanceOf(UploadResponseBodyError)
        else {
          const error: unknown = await upload.catch((error: unknown) => error)
          expect(error).toBeInstanceOf(NetworkError)
          expect((error as NetworkError).cause).not.toBeInstanceOf(UploadResponseBodyError)
          expect((error as NetworkError).cause).toHaveProperty('name', 'TimeoutError')
          expect(timedOutAfterStorage).toBe(true)
        }
        expect(attempts).toBe(phase === 'body-enabled' ? 2 : 1)
        expect((await bucket.listFileVersions({ prefix: 'timeout.bin' })).files).toHaveLength(
          phase === 'body-enabled' ? 2 : 1,
        )
      } finally {
        fetch.mockRestore()
      }
    },
  )
})
