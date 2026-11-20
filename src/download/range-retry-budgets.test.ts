import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { B2Error } from '../errors/index.ts'
import type { RawClient } from '../raw/index.ts'
import { readStream } from '../test-utils/index.ts'
import { fileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

type Failure = { phase: 'request' | 'body'; error: Error }

function scriptedRange(failures: readonly Failure[], maxRetries: number, initialRetryDelayMs = 0) {
  const expected = new Uint8Array([1, 2, 3, 4])
  let attempts = 0
  const raw = {
    async downloadFileById() {
      const failure = failures[attempts++]
      if (failure?.phase === 'request') throw failure.error
      return {
        status: 206,
        headers: new Headers({ 'Content-Range': 'bytes 0-3/4' }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            if (failure?.phase === 'body') controller.error(failure.error)
            else {
              controller.enqueue(expected)
              controller.close()
            }
          },
        }),
      }
    },
  } as unknown as RawClient
  const accountInfo = {
    getDownloadUrl: () => 'https://download.example.test',
    getAuthToken: () => 'test-token',
  } as unknown as AccountInfo
  return {
    expected,
    getAttempts: () => attempts,
    stream: createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: expected.length,
      maxRetries,
      bodyRetryOptions: { maxRetries, initialRetryDelayMs, maxRetryDelayMs: 100 },
    }),
  }
}

describe('parallel range retry budgets', () => {
  it('retries a body reset after using the request retry budget', async () => {
    const expected = new Uint8Array([1, 2, 3, 4])
    let attempts = 0
    const raw = {
      async downloadFileById() {
        attempts++
        if (attempts === 1) throw new TypeError('request connection reset')
        const failBody = attempts === 2
        let pulls = 0
        return {
          status: 206,
          headers: new Headers({ 'Content-Range': 'bytes 0-3/4' }),
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              if (failBody && pulls === 1) controller.enqueue(expected.slice(0, 2))
              else if (failBody) controller.error(new TypeError('body connection reset'))
              else {
                controller.enqueue(expected)
                controller.close()
              }
            },
          }),
        }
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'https://download.example.test',
      getAuthToken: () => 'test-token',
    } as unknown as AccountInfo
    const stream = createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: expected.length,
      maxRetries: 1,
      bodyRetryOptions: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })

    expect(await readStream(stream)).toEqual(expected)
    expect(attempts).toBe(3)
  })

  it('retries a request failure after using the body retry budget', async () => {
    const range = scriptedRange(
      [
        { phase: 'body', error: new TypeError('body reset') },
        { phase: 'request', error: new TypeError('request reset') },
      ],
      1,
    )

    expect(await readStream(range.stream)).toEqual(range.expected)
    expect(range.getAttempts()).toBe(3)
  })

  it.each([false, true])(
    'indexes each backoff independently (Retry-After: %s)',
    async (useRetryAfter) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0)
      const timers = vi.spyOn(globalThis, 'setTimeout')
      try {
        const firstRequestError = useRetryAfter
          ? new B2Error(
              { status: 503, code: 'service_unavailable', message: 'try again' },
              { retryAfter: 0.04 },
            )
          : new TypeError('request reset')
        const range = scriptedRange(
          [
            { phase: 'request', error: firstRequestError },
            { phase: 'body', error: new TypeError('body reset') },
            { phase: 'request', error: new TypeError('request reset') },
            { phase: 'body', error: new TypeError('body reset') },
          ],
          4,
          10,
        )

        expect(await readStream(range.stream)).toEqual(range.expected)
        expect(range.getAttempts()).toBe(5)
        expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([
          useRetryAfter ? 40 : 10,
          10,
          20,
          20,
        ])
      } finally {
        timers.mockRestore()
        random.mockRestore()
      }
    },
  )

  it.each(['request', 'body'] as const)(
    'does not retry a %s failure when maxRetries is zero',
    async (phase) => {
      const failure = new TypeError(`${phase} reset`)
      const range = scriptedRange([{ phase, error: failure }], 0)

      await expect(readStream(range.stream)).rejects.toBe(failure)
      expect(range.getAttempts()).toBe(1)
    },
  )

  it.each(['request', 'body'] as const)(
    'stops when the %s retry budget is exhausted',
    async (phase) => {
      const failure = new TypeError(`${phase} reset`)
      const range = scriptedRange(
        [
          { phase, error: failure },
          { phase, error: failure },
        ],
        1,
      )

      await expect(readStream(range.stream)).rejects.toBe(failure)
      expect(range.getAttempts()).toBe(2)
    },
  )

  it('does not start a range when the body retry limit alone is NaN', async () => {
    let attempts = 0
    const raw = {
      async downloadFileById() {
        attempts++
        return {
          status: 206,
          headers: new Headers({ 'Content-Range': 'bytes 0-0/1' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
              controller.close()
            },
          }),
        }
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'https://download.example.test',
      getAuthToken: () => 'test-token',
    } as unknown as AccountInfo
    const stream = createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: 1,
      bodyRetryOptions: { maxRetries: Number.NaN, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })

    await expect(readStream(stream)).rejects.toThrow('Range download failed after retries')
    expect(attempts).toBe(0)
  })

  it.each(['request', 'body'] as const)('does not retry an AbortError in %s', async (phase) => {
    const failure = new DOMException('cancelled', 'AbortError')
    const range = scriptedRange([{ phase, error: failure }], 2)

    await expect(readStream(range.stream)).rejects.toBe(failure)
    expect(range.getAttempts()).toBe(1)
  })

  it('does not retry after the caller aborts during a request', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped download')
    let attempts = 0
    const raw = {
      async downloadFileById(): Promise<never> {
        attempts++
        controller.abort(reason)
        throw new TypeError('request connection reset')
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'https://download.example.test',
      getAuthToken: () => 'test-token',
    } as unknown as AccountInfo
    const stream = createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: 4,
      maxRetries: 2,
      signal: controller.signal,
    })

    await expect(readStream(stream)).rejects.toBe(reason)
    expect(attempts).toBe(1)
  })
})
