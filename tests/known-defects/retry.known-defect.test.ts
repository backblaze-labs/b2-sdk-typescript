// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { sleep } from '../../src/http/retry.ts'
import type { HttpResponse, HttpTransport } from '../../src/http/transport.ts'
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
    let added = 0
    let removed = 0
    const listeners = new Set<unknown>()
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_type: string, listener: unknown) => {
        added++
        listeners.add(listener)
      },
      removeEventListener: (_type: string, listener: unknown) => {
        removed++
        listeners.delete(listener)
      },
    } as unknown as AbortSignal

    await sleep(1, signal)

    expect(added, 'expected exactly one abort listener to be added').toBe(1)
    expect(listeners.size, `listeners left on signal: added=${added} removed=${removed}`).toBe(0)
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
    let hits = 0
    const inner: HttpTransport = {
      async send(): Promise<HttpResponse> {
        hits++
        if (hits === 1) {
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

    const result = await retrying.send({
      method: 'GET',
      url: 'https://f000.backblazeb2.com/file/my-bucket/b2api/x/b2_upload_file',
      headers: { Authorization: 'tok' },
    })

    expect(result.status, 'GET did not succeed after the retry').toBe(200)
    expect(hits, 'expected the failed request plus one retry to the same URL').toBe(2)
  })
})
