import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  B2Error,
  B2RedirectError,
  ExpiredAuthTokenError,
  FinishLargeFileResponseBodyError,
  NetworkError,
  UploadResponseBodyError,
} from '../errors/index.ts'
import { RawClient } from '../raw/index.ts'
import type { AccountId, LargeFileId } from '../types/ids.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from './transport.ts'
import { FetchTransport, RetryTransport } from './transport.ts'

// ---------------------------------------------------------------------------
// Inject a no-op sleep into RetryTransport so retry tests don't actually wait.
// Module-level mocking (vi.mock + vi.importActual / importOriginal) differs
// between vitest and Bun's vitest-compat, so dependency injection is the
// portable approach.
// ---------------------------------------------------------------------------
const noSleep = (_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve()
type RetryTransportOpts = ConstructorParameters<typeof RetryTransport>[0]
function makeRetryTransport(opts: Omit<RetryTransportOpts, 'sleepImpl'>): RetryTransport {
  return new RetryTransport({ ...opts, sleepImpl: noSleep })
}

async function advanceTimersByTime(ms: number): Promise<void> {
  const maybeAsyncAdvance = (
    vi as typeof vi & { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
  ).advanceTimersByTimeAsync
  if (maybeAsyncAdvance !== undefined) {
    await maybeAsyncAdvance(ms)
    return
  }
  vi.advanceTimersByTime(ms)
  await Promise.resolve()
}

function observeRejection<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal HttpResponse-like object for use with the mock inner transport. */
const mockResponse = (
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): HttpResponse => ({
  status,
  headers: new Headers(headers),
  body: null,
  json: async () => body as never,
  text: async () => JSON.stringify(body),
  arrayBuffer: async () => new ArrayBuffer(0),
})

/** A basic POST request used across most tests. */
const baseRequest: HttpRequest = {
  url: 'https://api.backblazeb2.com/b2api/v3/b2_list_buckets',
  method: 'POST',
  headers: { Authorization: 'token-123' },
  body: JSON.stringify({ accountId: 'abc' }),
}

const textEncoder = new TextEncoder()

function stalledResponse(prefix = '{"ok":'): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode(prefix))
      },
    }),
    { status: 200 },
  )
}

// ============================================================================
// FetchTransport
// ============================================================================

describe('FetchTransport', () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
  })

  it('sets User-Agent header on requests', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport()
    await transport.send({ url: 'https://example.com', method: 'GET' })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.has('User-Agent')).toBe(true)
    expect(headers.get('User-Agent')).toMatch(/^b2-sdk-typescript\//)
  })

  it('uses a custom User-Agent prefix when provided', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport({ userAgent: 'my-app/1.0' })
    await transport.send({ url: 'https://example.com', method: 'GET' })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.get('User-Agent')).toMatch(/^my-app\/1\.0 b2-sdk-typescript\//)
  })

  it('routes the URL through the configured UrlGuard before fetch', async () => {
    const { UrlGuard } = await import('./url-guard.ts')
    const { B2SsrfError } = await import('../errors/index.ts')
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    const transport = new FetchTransport({ urlGuard: guard })

    // Permitted host: fetch is called.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    await transport.send({ url: 'https://api.backblazeb2.com/x', method: 'GET' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Rejected host: fetch must NOT be called. Defense in depth: even if the
    // upstream URL says https://169.254.169.254/, no TCP connection happens.
    fetchSpy.mockClear()
    await expect(
      transport.send({
        url: 'http://169.254.169.254/latest/meta-data/',
        method: 'GET',
      }),
    ).rejects.toBeInstanceOf(B2SsrfError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('blocks redirects explicitly so redirected URLs cannot bypass the guard', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    )

    const transport = new FetchTransport()
    await expect(
      transport.send({
        url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        method: 'GET',
        headers: { Authorization: 'Basic secret' },
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('cancels redirect response bodies before throwing', async () => {
    const redirectResponse = new Response('redirect body', {
      status: 302,
      headers: { Location: 'https://api.backblazeb2.com/next' },
    })
    const cancelSpy = vi.spyOn(redirectResponse.body as ReadableStream<Uint8Array>, 'cancel')
    fetchSpy.mockResolvedValue(redirectResponse)

    const transport = new FetchTransport()
    await expect(
      transport.send({
        url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        method: 'POST',
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('passes non-redirect 3xx responses through as ordinary responses', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 304 }))

    const transport = new FetchTransport()
    const response = await transport.send({ url: 'https://example.com/file', method: 'GET' })

    expect(response.status).toBe(304)
  })

  it('aborts a stalled fetch after the configured request timeout', async () => {
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )

    const transport = new FetchTransport()
    await expect(
      transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 1 },
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('propagates ordinary fetch failures when the request did not time out', async () => {
    const err = new TypeError('socket closed')
    fetchSpy.mockRejectedValue(err)

    const transport = new FetchTransport()
    await expect(
      transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 0 },
      }),
    ).rejects.toBe(err)
  })

  it('passes an already-aborted timeout signal through to fetch', async () => {
    const controller = new AbortController()
    const reason = new Error('already cancelled')
    controller.abort(reason)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport()
    await transport.send({
      url: 'https://example.com/file',
      method: 'GET',
      signal: controller.signal,
      retry: { requestTimeoutMs: 10_000 },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const signal = init.signal as AbortSignal
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
  })

  it('releases request timeout timers when supported', async () => {
    const realSetTimeout = globalThis.setTimeout
    const unref = vi.fn()
    type TimerWithOptionalUnref = ReturnType<typeof setTimeout> & { unref?: () => void }
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: Parameters<typeof setTimeout>[1],
    ) => {
      const timer = realSetTimeout(handler, timeout)
      if ((typeof timer === 'object' || typeof timer === 'function') && timer !== null) {
        const timerWithUnref = timer as TimerWithOptionalUnref
        timerWithUnref.unref = unref
        return timerWithUnref
      }
      const timerId = timer as unknown as number
      return {
        unref,
        valueOf: () => timerId,
        [Symbol.toPrimitive]: () => timerId,
      } as unknown as TimerWithOptionalUnref
    }) as unknown as typeof setTimeout)
    try {
      fetchSpy.mockResolvedValue(stalledResponse())

      const transport = new FetchTransport()
      const response = await transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 10_000 },
      })

      expect(unref).toHaveBeenCalledTimes(1)
      await response.body?.cancel()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('cancels the underlying response body when canceled before reading', async () => {
    const cancel = vi.fn()
    fetchSpy.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }),
    )

    const transport = new FetchTransport()
    const response = await transport.send({
      url: 'https://example.com/file',
      method: 'GET',
      retry: { requestTimeoutMs: 0 },
    })
    await response.body?.cancel('caller stopped reading')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe('caller stopped reading')
  })

  it('cancels the underlying response reader when canceled after reading', async () => {
    const cancel = vi.fn()
    fetchSpy.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
          },
          cancel,
        }),
        { status: 200 },
      ),
    )

    const transport = new FetchTransport()
    const response = await transport.send({
      url: 'https://example.com/file',
      method: 'GET',
      retry: { requestTimeoutMs: 10_000 },
    })
    const reader = response.body?.getReader()

    if (reader === undefined) throw new Error('expected response body')
    expect((await reader.read()).done).toBe(false)
    await reader.cancel('caller stopped after first chunk')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe('caller stopped after first chunk')
  })

  it('cancels the response body when a helper read is aborted', async () => {
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>(), { status: 200 })
    const cancelSpy = vi.spyOn(response.body as ReadableStream<Uint8Array>, 'cancel')
    fetchSpy.mockResolvedValue(response)

    const transport = new FetchTransport()
    const httpResponse = await transport.send({
      url: 'https://example.com/file',
      method: 'GET',
      signal: controller.signal,
      retry: { requestTimeoutMs: 10_000 },
    })

    const read = observeRejection(httpResponse.json())
    controller.abort('caller cancelled')
    await expect(read).rejects.toBe('caller cancelled')

    expect(cancelSpy).toHaveBeenCalledWith('caller cancelled')
  })

  it('cancels the locked response reader when a stream read is aborted', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    fetchSpy.mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 }),
    )

    const transport = new FetchTransport()
    const response = await transport.send({
      url: 'https://example.com/file',
      method: 'GET',
      signal: controller.signal,
      retry: { requestTimeoutMs: 10_000 },
    })
    const reader = response.body?.getReader()

    if (reader === undefined) throw new Error('expected response body')
    const read = observeRejection(reader.read())
    controller.abort('caller cancelled')
    await expect(read).rejects.toBe('caller cancelled')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe('caller cancelled')
  })

  it.each([
    'json',
    'text',
    'arrayBuffer',
  ] as const)('aborts a stalled response body read through %s()', async (method) => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValue(stalledResponse())

      const transport = new FetchTransport()
      const response = await transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 1 },
      })
      const read = observeRejection(response[method]())
      await advanceTimersByTime(1)

      await expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a stalled response body stream read', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValue(stalledResponse('partial'))

      const transport = new FetchTransport()
      const response = await transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 1 },
      })
      const reader = response.body?.getReader()
      expect((await reader?.read())?.done).toBe(false)
      if (reader === undefined) throw new Error('expected response body')
      const read = observeRejection(reader.read())
      await advanceTimersByTime(1)

      await expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets response body stream timeout after each received chunk', async () => {
    vi.useFakeTimers()
    try {
      let bodyController!: ReadableStreamDefaultController<Uint8Array>
      fetchSpy.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller
              controller.enqueue(new Uint8Array([1]))
            },
          }),
        ),
      )

      const transport = new FetchTransport()
      const response = await transport.send({
        url: 'https://example.com/file',
        method: 'GET',
        retry: { requestTimeoutMs: 10 },
      })
      const reader = response.body?.getReader()
      expect((await reader?.read())?.done).toBe(false)

      const secondRead = reader?.read()
      await advanceTimersByTime(9)
      bodyController.enqueue(new Uint8Array([2]))
      expect((await secondRead)?.done).toBe(false)

      const finalRead = reader?.read()
      await advanceTimersByTime(9)
      bodyController.close()
      expect((await finalRead)?.done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out stalled JSON bodies for normal raw API calls', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValue(stalledResponse())
      const raw = new RawClient({ transport: new FetchTransport() })

      const call = observeRejection(
        raw.listBuckets('https://api.example.com', 'auth', {
          accountId: 'account' as AccountId,
        }),
      )
      await advanceTimersByTime(15 * 60_000)

      await expect(call).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('wraps stalled upload response bodies as ambiguous upload failures', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValue(stalledResponse())
      const raw = new RawClient({ transport: new FetchTransport() })

      const call = observeRejection(
        raw.uploadFile(
          'https://pod.backblaze.com/b2_upload_file',
          {
            authorization: 'upload-auth',
            fileName: 'payload.bin',
            contentType: 'application/octet-stream',
            contentLength: 1,
            contentSha1: 'none',
            fileInfo: {},
          },
          new Uint8Array([1]) as BodyInit,
          undefined,
          { requestTimeoutMs: 1 },
        ),
      )
      await advanceTimersByTime(1)

      await expect(call).rejects.toBeInstanceOf(UploadResponseBodyError)
      await expect(call).rejects.toMatchObject({ cause: { name: 'TimeoutError' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['uploadFile', 'uploadPart'] as const)(
    'preserves caller aborts during %s response body reads',
    async (method) => {
      const controller = new AbortController()
      const reason = new Error('caller stopped waiting')
      fetchSpy.mockResolvedValue(stalledResponse())
      const raw = new RawClient({ transport: new FetchTransport() })

      const call =
        method === 'uploadFile'
          ? raw.uploadFile(
              'https://pod.backblaze.com/b2_upload_file',
              {
                authorization: 'upload-auth',
                fileName: 'payload.bin',
                contentType: 'application/octet-stream',
                contentLength: 1,
                contentSha1: 'none',
                fileInfo: {},
              },
              new Uint8Array([1]) as BodyInit,
              { signal: controller.signal, retry: { requestTimeoutMs: 10_000 } },
            )
          : raw.uploadPart(
              'https://pod.backblaze.com/b2_upload_part',
              {
                authorization: 'part-auth',
                partNumber: 1,
                contentLength: 1,
                contentSha1: 'none',
              },
              new Uint8Array([1]) as BodyInit,
              { signal: controller.signal, retry: { requestTimeoutMs: 10_000 } },
            )

      const observed = observeRejection(call as Promise<unknown>)
      controller.abort(reason)

      await expect(observed).rejects.toBe(reason)
    },
  )

  it('applies finishLargeFile retry timeout overrides to response body reads', async () => {
    vi.useFakeTimers()
    try {
      fetchSpy.mockResolvedValue(stalledResponse())
      const raw = new RawClient({ transport: new FetchTransport() })
      const fileId = '4_z_unfinished' as LargeFileId

      const call = observeRejection(
        raw.finishLargeFile(
          'https://api.example.com',
          'auth',
          {
            fileId,
            partSha1Array: [],
          },
          { retry: { requestTimeoutMs: 1 } },
        ),
      )
      await advanceTimersByTime(1)

      await expect(call).rejects.toBeInstanceOf(FinishLargeFileResponseBodyError)
      await expect(call).rejects.toMatchObject({ fileId, cause: { name: 'TimeoutError' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('follows guard-checked same-origin GET redirects by default', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('move', {
          status: 302,
          headers: { Location: '/file/bucket/object' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const transport = new FetchTransport()
    const response = await transport.send({
      url: 'https://f001.backblazeb2.com/file/bucket/old-object',
      method: 'GET',
    })

    expect(await response.text()).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect((fetchSpy.mock.calls[1] as [string, RequestInit])[0]).toBe(
      'https://f001.backblazeb2.com/file/bucket/object',
    )
  })

  it('can opt out of following same-origin GET redirects', async () => {
    fetchSpy.mockResolvedValue(
      new Response('move', {
        status: 302,
        headers: { Location: '/file/bucket/object' },
      }),
    )

    const transport = new FetchTransport({ followSameOriginRedirects: false })
    await expect(
      transport.send({
        url: 'https://f001.backblazeb2.com/file/bucket/old-object',
        method: 'GET',
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not follow cross-origin redirects when same-origin redirects are enabled', async () => {
    fetchSpy.mockResolvedValue(
      new Response('move', {
        status: 302,
        headers: { Location: 'https://evil.backblazeb2.com/file/bucket/object' },
      }),
    )

    const transport = new FetchTransport({ followSameOriginRedirects: true })
    await expect(
      transport.send({
        url: 'https://f001.backblazeb2.com/file/bucket/old-object',
        method: 'GET',
        headers: { Authorization: 'token-123' },
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not follow redirects with malformed Location headers', async () => {
    fetchSpy.mockResolvedValue(
      new Response('move', {
        status: 302,
        headers: { Location: 'http://[invalid' },
      }),
    )

    const transport = new FetchTransport({ followSameOriginRedirects: true })
    await expect(
      transport.send({
        url: 'https://f001.backblazeb2.com/file/bucket/old-object',
        method: 'GET',
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not follow POST redirects when same-origin redirects are enabled', async () => {
    fetchSpy.mockResolvedValue(
      new Response('move', {
        status: 307,
        headers: { Location: '/b2api/v3/b2_list_buckets' },
      }),
    )

    const transport = new FetchTransport({ followSameOriginRedirects: true })
    await expect(
      transport.send({
        url: 'https://api.backblazeb2.com/b2api/v3/b2_list_buckets',
        method: 'POST',
        headers: { Authorization: 'token-123' },
        body: '{}',
      }),
    ).rejects.toBeInstanceOf(B2RedirectError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('blocks opaque redirects returned by browser fetch implementations', async () => {
    fetchSpy.mockResolvedValue({
      status: 0,
      type: 'opaqueredirect',
      headers: new Headers(),
    } as Response)

    const transport = new FetchTransport()
    await expect(
      transport.send({
        url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        method: 'GET',
        headers: { Authorization: 'Basic secret' },
      }),
    ).rejects.toMatchObject({
      name: 'B2RedirectError',
      status: 0,
      location: null,
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.redirect).toBe('manual')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not override an existing User-Agent header', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport()
    await transport.send({
      url: 'https://example.com',
      method: 'GET',
      headers: { 'User-Agent': 'custom-agent/2.0' },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers as HeadersInit)
    expect(headers.get('User-Agent')).toBe('custom-agent/2.0')
  })

  it('returns a structured HttpResponse with status, headers, json(), text()', async () => {
    const payload = { buckets: [] }
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const transport = new FetchTransport()
    const response = await transport.send({ url: 'https://example.com', method: 'GET' })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
  })

  it('json() parses the response body', async () => {
    const payload = { buckets: [{ bucketName: 'test' }] }
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))

    const transport = new FetchTransport()
    const response = await transport.send({ url: 'https://example.com', method: 'GET' })
    const data = await response.json<typeof payload>()

    expect(data).toEqual(payload)
  })

  it('text() returns the raw response body', async () => {
    fetchSpy.mockResolvedValue(new Response('plain text response', { status: 200 }))

    const transport = new FetchTransport()
    const response = await transport.send({ url: 'https://example.com', method: 'GET' })
    const text = await response.text()

    expect(text).toBe('plain text response')
  })

  it('passes signal through to fetch', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    const controller = new AbortController()

    const transport = new FetchTransport()
    await transport.send({
      url: 'https://example.com',
      method: 'GET',
      signal: controller.signal,
      retry: { requestTimeoutMs: 0 },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('does not include signal in fetch options when signal is undefined', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport()
    await transport.send({
      url: 'https://example.com',
      method: 'GET',
      retry: { requestTimeoutMs: 0 },
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeUndefined()
  })

  it('passes method and body through to fetch', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))
    const bodyPayload = JSON.stringify({ accountId: 'abc' })

    const transport = new FetchTransport()
    await transport.send({
      url: 'https://api.example.com/endpoint',
      method: 'POST',
      body: bodyPayload,
    })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/endpoint')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(bodyPayload)
  })

  it('sends null body when body is not provided', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const transport = new FetchTransport()
    await transport.send({ url: 'https://example.com', method: 'GET' })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeNull()
  })
})

// ============================================================================
// RetryTransport
// ============================================================================

describe('RetryTransport', () => {
  let innerTransport: HttpTransport & { send: ReturnType<typeof vi.fn<HttpTransport['send']>> }

  beforeEach(() => {
    innerTransport = { send: vi.fn<HttpTransport['send']>() }
  })

  // --------------------------------------------------------------------------
  // Successful responses
  // --------------------------------------------------------------------------

  describe('successful responses', () => {
    it('returns response on first success (200)', async () => {
      const okResponse = mockResponse(200, { ok: true })
      innerTransport.send.mockResolvedValue(okResponse)

      const transport = makeRetryTransport({ transport: innerTransport })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('returns response for any 2xx status', async () => {
      const response204 = mockResponse(204, null)
      innerTransport.send.mockResolvedValue(response204)

      const transport = makeRetryTransport({ transport: innerTransport })
      const result = await transport.send(baseRequest)

      expect(result).toBe(response204)
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  // Retry on 503 (service_unavailable)
  // --------------------------------------------------------------------------

  describe('retry on 503', () => {
    it('retries on 503 and eventually succeeds', async () => {
      const errorBody = { status: 503, code: 'service_unavailable', message: 'Service unavailable' }
      const error503 = mockResponse(503, errorBody)
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send
        .mockResolvedValueOnce(error503)
        .mockResolvedValueOnce(error503)
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(3)
    })
  })

  // --------------------------------------------------------------------------
  // Retry on 500 (internal_error) and other transient 5xx
  // --------------------------------------------------------------------------

  describe('retry on 500', () => {
    it('retries on 500 internal_error and eventually succeeds', async () => {
      const errorBody = { status: 500, code: 'internal_error', message: 'Internal error' }
      const error500 = mockResponse(500, errorBody)
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send
        .mockResolvedValueOnce(error500)
        .mockResolvedValueOnce(error500)
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(3)
    })

    it('does not retry on HTTP 501 (excluded from the transient 5xx set)', async () => {
      // The decision is status-based; the code here is an incidental placeholder
      // (B2 has no 501-specific code). Status 501 must not be retried.
      const errorBody = { status: 501, code: 'bad_request', message: 'Not implemented' }
      const error501 = mockResponse(501, errorBody)

      innerTransport.send.mockResolvedValueOnce(error501)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      await expect(transport.send(baseRequest)).rejects.toBeInstanceOf(B2Error)
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('does not retry b2_start_large_file transient responses in place', async () => {
      const errorBody = { status: 503, code: 'service_unavailable', message: 'try later' }
      innerTransport.send
        .mockResolvedValueOnce(mockResponse(503, errorBody))
        .mockResolvedValueOnce(mockResponse(200, { fileId: '4_z_duplicate' }))

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(
        transport.send({
          ...baseRequest,
          url: 'https://api.backblazeb2.com/b2api/v3/b2_start_large_file',
        }),
      ).rejects.toBeInstanceOf(B2Error)
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    // Retryable upload pod failures are not retried in place. Upload endpoints
    // are URL-pinned, so pod failures bubble to the upload layer for fresh-URL
    // retry. HTTP 429 is covered separately because it is account-level
    // throttling and should retry in place.
    it.each([
      ['b2_upload_file', 408],
      ['b2_upload_file', 500],
      ['b2_upload_file', 502],
      ['b2_upload_file', 503],
      ['b2_upload_file', 504],
      ['b2_upload_part', 408],
      ['b2_upload_part', 500],
      ['b2_upload_part', 502],
      ['b2_upload_part', 503],
      ['b2_upload_part', 504],
    ] as const)('does not retry %s on HTTP %i in place', async (endpoint, status) => {
      const code = status === 408 ? 'request_timeout' : 'internal_error'
      const errorBody = { status, code, message: `HTTP ${status}` }
      // Second response would be 200 if it (wrongly) retried — assert it doesn't.
      innerTransport.send
        .mockResolvedValueOnce(mockResponse(status, errorBody))
        .mockResolvedValueOnce(mockResponse(200, { ok: true }))

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const uploadRequest: HttpRequest = {
        url: `https://pod-000.backblaze.com/b2api/v3/${endpoint}`,
        method: 'POST',
        headers: { Authorization: 'upload-token' },
      }
      await expect(transport.send(uploadRequest)).rejects.toBeInstanceOf(B2Error)
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it.each([
      'b2_upload_file',
      'b2_upload_part',
    ] as const)('retries %s on HTTP 429 in place and respects Retry-After', async (endpoint) => {
      const errorBody = { status: 429, code: 'too_many_requests', message: 'slow down' }
      innerTransport.send
        .mockResolvedValueOnce(mockResponse(429, errorBody, { 'Retry-After': '2' }))
        .mockResolvedValueOnce(mockResponse(200, { ok: true }))
      const sleepImpl = vi.fn<(_ms: number, _signal?: AbortSignal) => Promise<void>>(() =>
        Promise.resolve(),
      )

      const transport = new RetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 1, initialRetryDelayMs: 10, maxRetryDelayMs: 100_000 },
        sleepImpl,
      })
      const uploadRequest: HttpRequest = {
        url: `https://pod-000.backblaze.com/b2api/v3/${endpoint}`,
        method: 'POST',
        headers: { Authorization: 'upload-token' },
      }

      const result = await transport.send(uploadRequest)

      expect(result.status).toBe(200)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
      expect(innerTransport.send.mock.calls[0]?.[0].url).toBe(uploadRequest.url)
      expect(innerTransport.send.mock.calls[1]?.[0].url).toBe(uploadRequest.url)
      expect(sleepImpl).toHaveBeenCalledWith(2000, undefined)
    })

    it('does not treat b2_get_upload_url / b2_get_upload_part_url as upload endpoints (still retries 500)', async () => {
      // These are ordinary API calls (fetching an upload URL), not the
      // URL-pinned upload POST, so the generic 5xx retry still applies.
      const errorBody = { status: 500, code: 'internal_error', message: 'Internal error' }
      innerTransport.send
        .mockResolvedValueOnce(mockResponse(500, errorBody))
        .mockResolvedValueOnce(mockResponse(200, { ok: true }))

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send({
        url: 'https://api.backblazeb2.com/b2api/v3/b2_get_upload_part_url',
        method: 'POST',
        headers: { Authorization: 'token' },
      })
      expect(result.status).toBe(200)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it.each([
      'b2_upload_file',
      'b2_start_large_file',
      'b2_finish_large_file',
    ] as const)('does not treat a download named %s as replay-unsafe', async (fileName) => {
      // Download-by-name URLs are `/file/<bucket>/<fileName>` and the file name is
      // user-controlled, so B2 API endpoint names in file names must still retry.
      const errorBody = { status: 500, code: 'internal_error', message: 'Internal error' }
      innerTransport.send
        .mockResolvedValueOnce(mockResponse(500, errorBody))
        .mockResolvedValueOnce(mockResponse(200, { ok: true }))

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send({
        url: `https://f000.backblazeb2.com/file/my-bucket/${fileName}`,
        method: 'GET',
        headers: { Authorization: 'token' },
      })
      expect(result.status).toBe(200)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })
  })

  // --------------------------------------------------------------------------
  // Retry on 408 (request_timeout)
  // --------------------------------------------------------------------------

  describe('retry on 408', () => {
    it('retries on 408 and eventually succeeds', async () => {
      const errorBody = { status: 408, code: 'request_timeout', message: 'Request timeout' }
      const error408 = mockResponse(408, errorBody)
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send.mockResolvedValueOnce(error408).mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })
  })

  // --------------------------------------------------------------------------
  // Retry on 429 with Retry-After header
  // --------------------------------------------------------------------------

  describe('retry on 429 with Retry-After', () => {
    it('retries on 429 and respects Retry-After header', async () => {
      const errorBody = { status: 429, code: 'too_many_requests', message: 'Too many requests' }
      const error429 = mockResponse(429, errorBody, { 'Retry-After': '2' })
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send.mockResolvedValueOnce(error429).mockResolvedValueOnce(okResponse)

      // Inject a spied sleep so we can assert it was invoked between attempts.
      const sleepSpy = vi.fn().mockResolvedValue(undefined)
      const transport = new RetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100_000 },
        sleepImpl: sleepSpy,
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
      expect(sleepSpy).toHaveBeenCalled()
      // The first arg of the first call is the delay in ms; with Retry-After: 2s
      // computeBackoff returns 2000ms (capped at maxRetryDelayMs).
      const firstDelay = sleepSpy.mock.calls[0]?.[0] as number
      expect(firstDelay).toBe(2000)
    })
  })

  // --------------------------------------------------------------------------
  // Reauth on 401 expired_auth_token
  // --------------------------------------------------------------------------

  describe('reauth on 401 expired_auth_token', () => {
    it('calls onReauth and retries on expired auth token', async () => {
      const errorBody = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, errorBody)
      const okResponse = mockResponse(200, { ok: true })
      const onReauth = vi.fn().mockResolvedValue('refreshed-token')

      innerTransport.send.mockResolvedValueOnce(error401).mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        onReauth,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(onReauth).toHaveBeenCalledTimes(1)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('rewrites the request Authorization header with the fresh token before retrying', async () => {
      // Regression: previously, the retry path called `continue` and
      // re-sent the SAME HttpRequest object — which still had the
      // expired token baked into its Authorization header. The 401
      // would just bounce again and exhaust the retry budget without
      // the refreshed token ever reaching the wire.
      const errorBody = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, errorBody)
      const okResponse = mockResponse(200, { ok: true })
      const onReauth = vi.fn().mockResolvedValue('fresh-token-xyz')

      innerTransport.send.mockResolvedValueOnce(error401).mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        onReauth,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      const requestWithStaleToken = {
        ...baseRequest,
        headers: { Authorization: 'expired-token', 'Content-Type': 'application/json' },
      }
      await transport.send(requestWithStaleToken)

      // Two calls into the inner transport: first carries the expired
      // token, second carries the freshly-rewritten one.
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
      const firstCall = innerTransport.send.mock.calls[0]?.[0] as {
        headers: Record<string, string>
      }
      const secondCall = innerTransport.send.mock.calls[1]?.[0] as {
        headers: Record<string, string>
      }
      expect(firstCall?.headers?.['Authorization']).toBe('expired-token')
      expect(secondCall?.headers?.['Authorization']).toBe('fresh-token-xyz')
      // Other headers untouched.
      expect(secondCall?.headers?.['Content-Type']).toBe('application/json')
    })

    it('retries after reauth even when maxRetries is zero', async () => {
      const errorBody = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, errorBody)
      const okResponse = mockResponse(200, { ok: true })
      const onReauth = vi.fn().mockResolvedValue('fresh-token-zero-budget')

      innerTransport.send.mockResolvedValueOnce(error401).mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        onReauth,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(onReauth).toHaveBeenCalledTimes(1)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('does not loop forever on repeated reauth failures', async () => {
      const errorBody = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, errorBody)
      const onReauth = vi.fn().mockResolvedValue('still-bad-token')

      innerTransport.send.mockResolvedValue(error401)

      const transport = makeRetryTransport({
        transport: innerTransport,
        onReauth,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow(ExpiredAuthTokenError)
      expect(onReauth).toHaveBeenCalledTimes(1)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('throws expired auth token error when no onReauth callback is provided', async () => {
      const errorBody = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, errorBody)

      innerTransport.send.mockResolvedValue(error401)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      // Without onReauth, expired_auth_token is still retryable, so it retries until maxRetries
      // then throws on the last attempt
      await expect(transport.send(baseRequest)).rejects.toThrow(ExpiredAuthTokenError)
    })
  })

  // --------------------------------------------------------------------------
  // Non-retryable errors throw immediately
  // --------------------------------------------------------------------------

  describe('non-retryable errors', () => {
    it('throws immediately on 403 access_denied', async () => {
      const errorBody = { status: 403, code: 'access_denied', message: 'Access denied' }
      const error403 = mockResponse(403, errorBody)

      innerTransport.send.mockResolvedValue(error403)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow('Access denied')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('throws immediately on 400 bad_request', async () => {
      const errorBody = { status: 400, code: 'bad_request', message: 'Bad request' }
      const error400 = mockResponse(400, errorBody)

      innerTransport.send.mockResolvedValue(error400)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow('Bad request')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('non-retryable error is a B2Error instance', async () => {
      const errorBody = { status: 403, code: 'access_denied', message: 'Access denied' }
      const error403 = mockResponse(403, errorBody)

      innerTransport.send.mockResolvedValue(error403)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(B2Error)
        expect((err as B2Error).code).toBe('access_denied')
        expect((err as B2Error).status).toBe(403)
        expect((err as B2Error).retryable).toBe(false)
      }
    })
  })

  // --------------------------------------------------------------------------
  // Max retries exhausted
  // --------------------------------------------------------------------------

  describe('max retries exhausted', () => {
    it('throws after max retries are exhausted on retryable errors', async () => {
      const errorBody = { status: 503, code: 'service_unavailable', message: 'Service unavailable' }
      const error503 = mockResponse(503, errorBody)

      // Always return 503
      innerTransport.send.mockResolvedValue(error503)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 2, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow('Service unavailable')
      // initial attempt + 2 retries = 3 calls total
      expect(innerTransport.send).toHaveBeenCalledTimes(3)
    })

    it('thrown error after max retries is a B2Error with retryable=true', async () => {
      const errorBody = { status: 503, code: 'service_unavailable', message: 'Service unavailable' }
      const error503 = mockResponse(503, errorBody)
      innerTransport.send.mockResolvedValue(error503)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 1, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(B2Error)
        expect((err as B2Error).retryable).toBe(true)
      }
    })
  })

  // --------------------------------------------------------------------------
  // Network errors (fetch TypeError)
  // --------------------------------------------------------------------------

  describe('network errors', () => {
    it('wraps fetch TypeError as NetworkError and retries', async () => {
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('throws NetworkError after max retries on persistent network failure', async () => {
      innerTransport.send.mockRejectedValue(new TypeError('Failed to fetch'))

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 2, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError)
        expect((err as NetworkError).message).toBe('Failed to fetch')
        expect((err as NetworkError).retryable).toBe(true)
      }
      // initial attempt + 2 retries = 3 calls
      expect(innerTransport.send).toHaveBeenCalledTimes(3)
    })

    it('wraps non-Error thrown values as NetworkError with generic message', async () => {
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send.mockRejectedValueOnce('string error').mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('retries request timeout aborts as network failures', async () => {
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send
        .mockRejectedValueOnce(new DOMException('HTTP request timed out', 'TimeoutError'))
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 1, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('retries non-2xx response body timeouts as network failures', async () => {
      const okResponse = mockResponse(200, { ok: true })
      const stalledErrorResponse: HttpResponse = {
        status: 503,
        headers: new Headers(),
        body: null,
        json: async () => {
          throw new DOMException('HTTP request timed out after 1 ms', 'TimeoutError')
        },
        text: async () => 'unused',
        arrayBuffer: async () => new ArrayBuffer(0),
      }

      innerTransport.send
        .mockResolvedValueOnce(stalledErrorResponse)
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 1, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('does not replay finishLargeFile request timeouts', async () => {
      innerTransport.send.mockRejectedValue(
        new DOMException('HTTP request timed out', 'TimeoutError'),
      )

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(
        transport.send({
          ...baseRequest,
          url: 'https://api.backblazeb2.com/b2api/v3/b2_finish_large_file',
        }),
      ).rejects.toMatchObject({
        name: 'NetworkError',
        cause: { name: 'TimeoutError' },
      })
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('does not replay startLargeFile request timeouts', async () => {
      innerTransport.send.mockRejectedValue(
        new DOMException('HTTP request timed out', 'TimeoutError'),
      )

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(
        transport.send({
          ...baseRequest,
          url: 'https://api.backblazeb2.com/b2api/v3/b2_start_large_file',
        }),
      ).rejects.toMatchObject({
        name: 'NetworkError',
        cause: { name: 'TimeoutError' },
      })
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  // AbortError propagation
  // --------------------------------------------------------------------------

  describe('AbortError propagation', () => {
    it('propagates AbortError without retry', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      innerTransport.send.mockRejectedValue(abortError)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow('The operation was aborted')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('thrown error is the original DOMException', async () => {
      const abortError = new DOMException('Aborted', 'AbortError')
      innerTransport.send.mockRejectedValue(abortError)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(DOMException)
        expect((err as DOMException).name).toBe('AbortError')
      }
    })

    it('does not retry when an abort signal rejects with a custom reason', async () => {
      const controller = new AbortController()
      innerTransport.send.mockImplementation(async () => {
        controller.abort('caller cancelled')
        throw new Error('transport observed abort')
      })

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send({ ...baseRequest, signal: controller.signal })).rejects.toBe(
        'caller cancelled',
      )
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('cancels the response body when aborted after inner send resolves', async () => {
      const controller = new AbortController()
      const cancel = vi.fn()
      const response: HttpResponse = {
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({ cancel }),
        json: async () => ({ ok: true }) as never,
        text: async () => 'ok',
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      innerTransport.send.mockImplementation(async () => {
        controller.abort('caller cancelled')
        return response
      })

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send({ ...baseRequest, signal: controller.signal })).rejects.toBe(
        'caller cancelled',
      )
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(cancel.mock.calls[0]?.[0]).toBe('caller cancelled')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  // SDK errors re-thrown without wrapping
  // --------------------------------------------------------------------------

  describe('SDK errors re-thrown without wrapping', () => {
    it('re-throws B2Error from inner transport without wrapping', async () => {
      const b2Err = new B2Error({ status: 500, code: 'internal_error', message: 'Internal error' })
      innerTransport.send.mockRejectedValue(b2Err)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBe(b2Err)
      }
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('re-throws NetworkError from inner transport without wrapping', async () => {
      const netErr = new NetworkError('custom network error')
      innerTransport.send.mockRejectedValue(netErr)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBe(netErr)
      }
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('re-throws B2RedirectError without retrying', async () => {
      const redirectErr = new B2RedirectError(
        'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        302,
        'http://user:secret@169.254.169.254/latest/meta-data/',
      )
      innerTransport.send.mockRejectedValue(redirectErr)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toBe(redirectErr)
      expect(redirectErr.retryable).toBe(false)
      expect(redirectErr.location).toBe('http://169.254.169.254/...')
      expect(redirectErr.message).not.toContain('secret')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  // Error body parsing failure
  // --------------------------------------------------------------------------

  describe('error body parsing failure', () => {
    it('uses fallback error body when json() throws', async () => {
      const badResponse: HttpResponse = {
        status: 503,
        headers: new Headers(),
        body: null,
        json: async () => {
          throw new Error('invalid json')
        },
        text: async () => 'not json',
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      const okResponse = mockResponse(200, { ok: true })

      innerTransport.send.mockResolvedValueOnce(badResponse).mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })
      const result = await transport.send(baseRequest)

      expect(result).toBe(okResponse)
      expect(innerTransport.send).toHaveBeenCalledTimes(2)
    })

    it('fallback error body has correct status and code', async () => {
      const badResponse: HttpResponse = {
        status: 500,
        headers: new Headers(),
        body: null,
        json: async () => {
          throw new Error('parse error')
        },
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      }
      innerTransport.send.mockResolvedValue(badResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(B2Error)
        expect((err as B2Error).status).toBe(500)
        expect((err as B2Error).code).toBe('internal_error')
        expect((err as B2Error).message).toBe('HTTP 500')
      }
    })
  })

  // --------------------------------------------------------------------------
  // Fall-through: lastError thrown when loop ends
  // --------------------------------------------------------------------------

  describe('loop exhaustion fallback', () => {
    it('throws lastError when the retry loop completes without return or throw', async () => {
      // With maxRetries=0, the loop runs once (attempt 0 only).
      // A retryable error on the first (and only) attempt at attempt === maxRetries
      // will throw immediately from the "attempt === this.options.maxRetries" branch.
      const errorBody = { status: 503, code: 'service_unavailable', message: 'Unavailable' }
      const error503 = mockResponse(503, errorBody)
      innerTransport.send.mockResolvedValue(error503)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toThrow('Unavailable')
      expect(innerTransport.send).toHaveBeenCalledTimes(1)
    })

    it('throws a fallback NetworkError when the retry budget skips the loop', async () => {
      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: -1, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      await expect(transport.send(baseRequest)).rejects.toMatchObject({
        message: 'Max retries exceeded',
      })
      expect(innerTransport.send).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // Request ID and Retry-After headers are attached to errors
  // --------------------------------------------------------------------------

  describe('error metadata from response headers', () => {
    it('attaches requestId from X-Bz-Request-Id header', async () => {
      const errorBody = { status: 403, code: 'access_denied', message: 'Denied' }
      const errorResponse = mockResponse(403, errorBody, {
        'X-Bz-Request-Id': 'req-abc-123',
      })
      innerTransport.send.mockResolvedValue(errorResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(B2Error)
        expect((err as B2Error).requestId).toBe('req-abc-123')
      }
    })

    it('attaches retryAfter parsed from Retry-After header', async () => {
      const errorBody = { status: 429, code: 'too_many_requests', message: 'Rate limited' }
      const errorResponse = mockResponse(429, errorBody, { 'Retry-After': '5' })
      innerTransport.send.mockResolvedValue(errorResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        retry: { maxRetries: 0, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      try {
        await transport.send(baseRequest)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(B2Error)
        expect((err as B2Error).retryAfter).toBe(5)
      }
    })
  })

  // --------------------------------------------------------------------------
  // Default retry options
  // --------------------------------------------------------------------------

  describe('default retry options', () => {
    it('uses DEFAULT_RETRY_OPTIONS when no retry config is provided', async () => {
      const errorBody = { status: 503, code: 'service_unavailable', message: 'Unavailable' }
      const error503 = mockResponse(503, errorBody)
      innerTransport.send.mockResolvedValue(error503)

      const transport = makeRetryTransport({ transport: innerTransport })

      await expect(transport.send(baseRequest)).rejects.toThrow('Unavailable')
      // default maxRetries is 5, so: initial + 5 retries = 6 calls total
      expect(innerTransport.send).toHaveBeenCalledTimes(6)
    })
  })

  // --------------------------------------------------------------------------
  // Reauth with continue (does not consume a retry attempt)
  // --------------------------------------------------------------------------

  describe('reauth does not consume a retry attempt', () => {
    it('onReauth + continue allows the full retry budget afterward', async () => {
      const authError = { status: 401, code: 'expired_auth_token', message: 'Token expired' }
      const error401 = mockResponse(401, authError)
      const serviceError = { status: 503, code: 'service_unavailable', message: 'Down' }
      const error503 = mockResponse(503, serviceError)
      const okResponse = mockResponse(200, { ok: true })

      const onReauth = vi.fn().mockResolvedValue('refreshed-token')

      // First call: 401 (triggers reauth + continue, does not increment attempt)
      // Second call: 503 (retryable, attempt 0 still)
      // Third call: success
      innerTransport.send
        .mockResolvedValueOnce(error401)
        .mockResolvedValueOnce(error503)
        .mockResolvedValueOnce(okResponse)

      const transport = makeRetryTransport({
        transport: innerTransport,
        onReauth,
        retry: { maxRetries: 2, initialRetryDelayMs: 10, maxRetryDelayMs: 100 },
      })

      const result = await transport.send(baseRequest)
      expect(result).toBe(okResponse)
      expect(onReauth).toHaveBeenCalledTimes(1)
      expect(innerTransport.send).toHaveBeenCalledTimes(3)
    })
  })
})
