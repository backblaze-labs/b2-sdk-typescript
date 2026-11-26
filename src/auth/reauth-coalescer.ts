import { abortReason, raceWithAbort, throwIfSignalAborted } from '../util/abort.ts'

/** Callback that performs the shared reauthorization work. */
export type ReauthRefresh<T> = (signal: AbortSignal) => Promise<T>

/** Callback that reads the currently stored authorization value, if any. */
export type ReauthCurrent<T> = () => T | null | undefined

interface InflightReauth<T> {
  readonly controller: AbortController
  readonly promise: Promise<T>
  waiters: number
  settled: boolean
}

/**
 * Coalesces concurrent reauthorization requests into one in-flight refresh.
 * Each caller waits independently with its own abort signal. The shared
 * refresh receives a coalescer-owned signal and is aborted only when every
 * active waiter has stopped waiting before the refresh settles. A successful,
 * failed, or aborted refresh clears the in-flight slot so the next call can
 * start a new refresh.
 *
 * A caller whose request failed with an older value than the one the last
 * refresh produced gets that newer value back without a new refresh, as long
 * as it is still the current stored value. This covers a 401 that arrives
 * after the shared refresh for the same expiry has already finished.
 *
 * @internal
 */
export class ReauthCoalescer<T> {
  readonly #refresh: ReauthRefresh<T>
  readonly #current: ReauthCurrent<T> | undefined
  #inflight: InflightReauth<T> | null = null
  #latest: { readonly value: T } | null = null

  /**
   * Creates a new reauthorization coalescer.
   *
   * @param refresh - The callback that performs one shared refresh.
   * @param current - Optional callback that reads the currently stored value.
   *   Without it, every call outside an in-flight refresh starts a new one.
   */
  constructor(refresh: ReauthRefresh<T>, current?: ReauthCurrent<T>) {
    this.#refresh = refresh
    this.#current = current
  }

  /**
   * Runs or joins the current refresh. If `signal` is already aborted, the
   * refresh callback is not called. If this waiter aborts while other waiters
   * remain, only this call rejects; the shared refresh continues for the
   * remaining waiters.
   *
   * @param signal - Optional abort signal for this waiter.
   * @param staleValue - Optional value the caller's failed request used. When
   *   it differs from the last refreshed value and that value is still
   *   current, the last refreshed value is returned without a new refresh.
   *
   * @returns The shared refresh result, or the newer current value.
   */
  run(signal?: AbortSignal, staleValue?: T): Promise<T> {
    throwIfSignalAborted(signal)
    if (this.#inflight === null) {
      const newer = this.newerCurrentValue(staleValue)
      if (newer !== null) return Promise.resolve(newer.value)
    }
    const inflight = this.#inflight ?? this.start()
    inflight.waiters += 1
    return raceWithAbort(inflight.promise, signal).finally(() => {
      inflight.waiters -= 1
      if (inflight.waiters === 0 && !inflight.settled && !inflight.controller.signal.aborted) {
        /* v8 ignore next -- waiters can only leave an unsettled refresh by aborting their signal */
        inflight.controller.abort(signal?.aborted === true ? abortReason(signal) : undefined)
      }
    })
  }

  private newerCurrentValue(staleValue: T | undefined): { readonly value: T } | null {
    const latest = this.#latest
    if (staleValue === undefined || latest === null || this.#current === undefined) return null
    if (staleValue === latest.value || this.#current() !== latest.value) return null
    return latest
  }

  private start(): InflightReauth<T> {
    const controller = new AbortController()
    const promise = raceWithAbort(this.#refresh(controller.signal), controller.signal)
      .then((value) => {
        this.#latest = { value }
        return value
      })
      .finally(() => {
        /* v8 ignore next -- defensive: callers cannot start a replacement while this is current */
        if (this.#inflight?.controller !== controller) return
        this.#inflight.settled = true
        this.#inflight = null
      })
    const inflight: InflightReauth<T> = {
      controller,
      promise,
      waiters: 0,
      settled: false,
    }
    this.#inflight = inflight
    return inflight
  }
}
