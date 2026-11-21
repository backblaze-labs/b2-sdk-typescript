// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { sleep } from '../../src/http/retry.ts'

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
