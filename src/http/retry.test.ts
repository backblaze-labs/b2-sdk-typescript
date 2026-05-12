import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions, computeBackoff, sleep } from './retry.ts'

describe('DEFAULT_RETRY_OPTIONS', () => {
  it('has the expected defaults', () => {
    expect(DEFAULT_RETRY_OPTIONS).toEqual({
      maxRetries: 5,
      maxRetryDelayMs: 64_000,
      initialRetryDelayMs: 1_000,
    })
  })
})

describe('computeBackoff', () => {
  const options: RetryOptions = {
    maxRetries: 5,
    maxRetryDelayMs: 10_000,
    initialRetryDelayMs: 1_000,
  }

  describe('when retryAfter is provided', () => {
    it('returns retryAfter converted to milliseconds', () => {
      const result = computeBackoff(0, options, 3)
      expect(result).toBe(3_000)
    })

    it('caps retryAfter at maxRetryDelayMs', () => {
      const result = computeBackoff(0, options, 20)
      expect(result).toBe(options.maxRetryDelayMs)
    })

    it('ignores retryAfter when it is zero', () => {
      // retryAfter = 0 should fall through to the exponential backoff path
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const result = computeBackoff(0, options, 0)
      // With jitter = 0, base = 1000 * 2^0 = 1000
      expect(result).toBe(1_000)
      vi.restoreAllMocks()
    })

    it('ignores retryAfter when it is negative', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const result = computeBackoff(0, options, -5)
      expect(result).toBe(1_000)
      vi.restoreAllMocks()
    })
  })

  describe('exponential backoff without retryAfter', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('uses initialRetryDelayMs as the base for attempt 0', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const result = computeBackoff(0, options)
      // base = 1000 * 2^0 = 1000, jitter = 0
      expect(result).toBe(1_000)
    })

    it('doubles the base delay on each subsequent attempt', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      expect(computeBackoff(0, options)).toBe(1_000)
      expect(computeBackoff(1, options)).toBe(2_000)
      expect(computeBackoff(2, options)).toBe(4_000)
      expect(computeBackoff(3, options)).toBe(8_000)
    })

    it('caps the result at maxRetryDelayMs', () => {
      // attempt 4: base = 1000 * 16 = 16000, which exceeds maxRetryDelayMs (10000)
      vi.spyOn(Math, 'random').mockReturnValue(0.5)
      const result = computeBackoff(4, options)
      expect(result).toBe(options.maxRetryDelayMs)
    })

    it('adds jitter bounded by 0.5 * base', () => {
      // With random = 1, jitter = 1.0 * base * 0.5 = 500 for attempt 0
      vi.spyOn(Math, 'random').mockReturnValue(1)
      const result = computeBackoff(0, options)
      // base = 1000, jitter = 1000 * 0.5 = 500
      expect(result).toBe(1_500)
    })

    it('jitter is zero when Math.random returns 0', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0)
      const result = computeBackoff(0, options)
      expect(result).toBe(1_000)
    })

    it('jitter stays within [0, 0.5 * base] across many samples', () => {
      vi.restoreAllMocks() // use real Math.random for this test
      const base = options.initialRetryDelayMs // attempt 0: base = 1000
      for (let i = 0; i < 100; i++) {
        const result = computeBackoff(0, options)
        expect(result).toBeGreaterThanOrEqual(base)
        expect(result).toBeLessThanOrEqual(base * 1.5)
      }
    })
  })
})

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now()
    await sleep(5)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(3) // allow small timing tolerance
  })

  it('rejects immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(sleep(1_000, controller.signal)).rejects.toThrow('cancelled')
  })

  it('uses a default DOMException when signal.reason is falsy (pre-aborted)', async () => {
    // Create a fake AbortSignal where aborted is true but reason is undefined,
    // forcing the ?? fallback path on line 54.
    const fakeSignal = {
      aborted: true,
      reason: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as AbortSignal
    try {
      await sleep(1_000, fakeSignal)
      expect.unreachable('sleep should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe('AbortError')
    }
  })

  it('rejects when signal aborts during sleep', async () => {
    const controller = new AbortController()
    const promise = sleep(10_000, controller.signal)
    // Abort after a very short delay
    setTimeout(() => controller.abort(new Error('mid-sleep abort')), 2)
    await expect(promise).rejects.toThrow('mid-sleep abort')
  })

  it('uses a default DOMException when signal.reason is falsy (mid-sleep abort)', async () => {
    // Create a fake AbortSignal that starts non-aborted, then fires the
    // abort listener with reason still undefined, forcing the ?? fallback
    // on line 62.
    let abortListener: (() => void) | undefined
    const fakeSignal = {
      aborted: false,
      reason: undefined,
      addEventListener(_event: string, handler: () => void) {
        abortListener = handler
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal

    const promise = sleep(10_000, fakeSignal)
    // Fire the stored abort listener to simulate an abort with no reason
    abortListener?.()

    try {
      await promise
      expect.unreachable('sleep should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe('AbortError')
    }
  })

  it('clears the timer on abort so it does not leak', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    const promise = sleep(10_000, controller.signal)
    controller.abort(new Error('abort'))
    await expect(promise).rejects.toThrow('abort')
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('resolves without a signal', async () => {
    // Verify sleep works when no signal is passed at all (undefined path)
    await expect(sleep(1)).resolves.toBeUndefined()
  })
})
