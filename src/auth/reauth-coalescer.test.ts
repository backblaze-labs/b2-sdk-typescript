import { describe, expect, it, vi } from 'vitest'
import { deferred } from '../test-utils/index.ts'
import { ReauthCoalescer } from './reauth-coalescer.ts'

describe('ReauthCoalescer', () => {
  it('rejects pre-aborted waiters without starting refresh', async () => {
    const refresh = vi.fn<(_signal: AbortSignal) => Promise<string>>(async () => 'unused')
    const coalescer = new ReauthCoalescer(refresh)
    const controller = new AbortController()
    const reason = new DOMException('already canceled', 'AbortError')

    controller.abort(reason)

    expect(() => coalescer.run(controller.signal)).toThrow(reason)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps the shared refresh alive when one waiter aborts', async () => {
    const refreshGate = deferred<string>()
    let refreshSignal: AbortSignal | undefined
    let refreshCalls = 0
    const coalescer = new ReauthCoalescer<string>((signal) => {
      refreshCalls += 1
      refreshSignal = signal
      return refreshGate.promise
    })
    const firstController = new AbortController()
    const firstReason = new DOMException('first canceled', 'AbortError')

    const first = coalescer.run(firstController.signal)
    const second = coalescer.run()
    firstController.abort(firstReason)

    await expect(first).rejects.toBe(firstReason)
    expect(refreshSignal?.aborted).toBe(false)

    refreshGate.resolve('fresh-token')

    await expect(second).resolves.toBe('fresh-token')
    expect(refreshCalls).toBe(1)
  })

  it('aborts the shared refresh after all waiters abort', async () => {
    const refreshStarted = deferred<void>()
    const refreshAborted = deferred<unknown>()
    let refreshCalls = 0
    const coalescer = new ReauthCoalescer<string>((signal) => {
      refreshCalls += 1
      if (refreshCalls > 1) return Promise.resolve('replacement-token')

      refreshStarted.resolve(undefined)
      return new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            refreshAborted.resolve(signal.reason)
            reject(signal.reason)
          },
          { once: true },
        )
      })
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstReason = new DOMException('first canceled', 'AbortError')
    const secondReason = new DOMException('second canceled', 'AbortError')

    const first = coalescer.run(firstController.signal)
    const second = coalescer.run(secondController.signal)
    await refreshStarted.promise

    firstController.abort(firstReason)
    await expect(first).rejects.toBe(firstReason)

    secondController.abort(secondReason)
    await expect(second).rejects.toBe(secondReason)
    await expect(refreshAborted.promise).resolves.toBe(secondReason)

    await expect(coalescer.run()).resolves.toBe('replacement-token')
    expect(refreshCalls).toBe(2)
  })

  it('clears the in-flight refresh after a failure', async () => {
    const firstFailure = new Error('refresh failed')
    let refreshCalls = 0
    const coalescer = new ReauthCoalescer<string>(async () => {
      refreshCalls += 1
      if (refreshCalls === 1) throw firstFailure
      return 'fresh-token'
    })

    await expect(coalescer.run()).rejects.toBe(firstFailure)
    await expect(coalescer.run()).resolves.toBe('fresh-token')
    expect(refreshCalls).toBe(2)
  })

  it('does not abort a refresh that settles normally for the final waiter', async () => {
    let refreshSignal: AbortSignal | undefined
    const coalescer = new ReauthCoalescer<string>(async (signal) => {
      refreshSignal = signal
      return 'fresh-token'
    })

    await expect(coalescer.run()).resolves.toBe('fresh-token')

    expect(refreshSignal?.aborted).toBe(false)
  })
})
