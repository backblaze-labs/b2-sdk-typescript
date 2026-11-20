import { describe, expect, it, vi } from 'vitest'
import { sleep } from './retry.ts'

function trackAbortListeners(signal: AbortSignal): Set<unknown> {
  const listeners = new Set<unknown>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)

  signal.addEventListener = ((type: string, listener: never, options?: never) => {
    if (type === 'abort') listeners.add(listener)
    add(type, listener, options)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: never, options?: never) => {
    if (type === 'abort') listeners.delete(listener)
    remove(type, listener, options)
  }) as typeof signal.removeEventListener
  return listeners
}

describe('retry sleep abort listener cleanup', () => {
  it('returns to the existing listener count after each completed sleep', async () => {
    const controller = new AbortController()
    const listeners = trackAbortListeners(controller.signal)
    const unrelated = () => {}
    controller.signal.addEventListener('abort', unrelated)
    const baseline = listeners.size
    const counts: number[] = []
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 4; i++) {
        const waiting = sleep(10, controller.signal)
        vi.advanceTimersByTime(10)
        await waiting
        counts.push(listeners.size)
      }
    } finally {
      vi.useRealTimers()
    }

    expect(baseline).toBe(1)
    expect(counts).toEqual([baseline, baseline, baseline, baseline])
    expect(listeners.has(unrelated)).toBe(true)
  })

  it('rejects an in-flight sleep with the abort reason and clears its timer', async () => {
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const controller = new AbortController()
      const reason = new Error('retry cancelled')
      const waiting = sleep(60_000, controller.signal)
      controller.abort(reason)

      await expect(waiting).rejects.toBe(reason)
      expect(clearTimer).toHaveBeenCalledOnce()
    } finally {
      clearTimer.mockRestore()
    }
  })
})
