// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { sleep } from '../../src/http/retry.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { RetryTransport } from '../../src/http/transport.ts'

const noSleep = (): Promise<void> => Promise.resolve()

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: new Headers(),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

describe('retry sleep must not leak abort listeners', () => {
  it('removes its abort listener from the caller signal once the delay elapses normally', async () => {
    const signal = new AbortController().signal
    const baseline = getEventListeners(signal, 'abort').length
    vi.useFakeTimers()
    try {
      const sleeping = sleep(1, signal)
      await vi.advanceTimersByTimeAsync(1)
      await sleeping
    } finally {
      vi.useRealTimers()
    }

    expect(
      getEventListeners(signal, 'abort').length,
      'abort listeners left on the caller signal after the delay elapsed',
    ).toBe(baseline)
  })

  it('does not accumulate listeners on a long-lived signal across many retry sleeps', async () => {
    const controller = new AbortController()
    const live = new Set<unknown>()
    const realAdd = controller.signal.addEventListener.bind(controller.signal)
    const realRemove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((type: string, l: never, o?: never) => {
      if (type === 'abort') live.add(l)
      realAdd(type, l, o)
    }) as typeof controller.signal.addEventListener
    controller.signal.removeEventListener = ((type: string, l: never, o?: never) => {
      if (type === 'abort') live.delete(l)
      realRemove(type, l, o)
    }) as typeof controller.signal.removeEventListener

    for (let i = 0; i < 20; i++) await sleep(0, controller.signal)

    expect(live.size, `abort listeners still attached after 20 sleeps: ${live.size}`).toBe(0)
  })
})

describe('endpoint classification must not be fooled by a download file name', () => {
  it('retries a GET download in place when the file name contains b2api/x/b2_upload_file', async () => {
    const requests: { method: string; url: string }[] = []
    const inner: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        requests.push({ method: req.method, url: req.url })
        if (requests.length === 1) {
          return response(500, { status: 500, code: 'internal_error', message: 'boom' })
        }
        return response(200, { ok: true })
      },
    }
    const retrying = new RetryTransport({
      transport: inner,
      retry: { maxRetries: 3, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      sleepImpl: noSleep,
    })

    const url = 'https://f000.backblazeb2.com/file/my-bucket/b2api/x/b2_upload_file'
    const result = await retrying.send({
      method: 'GET',
      url,
      headers: { Authorization: 'tok' },
    })

    expect(result.status, 'GET did not succeed after the retry').toBe(200)
    // The original GET is retried in place: same method, same URL, exactly one retry.
    expect(requests).toEqual([
      { method: 'GET', url },
      { method: 'GET', url },
    ])
  })
})
