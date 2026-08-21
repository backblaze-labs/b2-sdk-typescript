import { abortReason, raceWithAbort, throwIfSignalAborted } from '../util/abort.ts'

/** Callback that performs the shared reauthorization work. */
export type ReauthRefresh<T> = (signal: AbortSignal) => Promise<T>

interface InflightReauth<T> {
  readonly controller: AbortController
  readonly promise: Promise<T>
  waiters: number
  settled: boolean
}

/**
 * Coalesces concurrent reauthorization requests into one in-flight refresh.
 *
 * @internal
 */
export class ReauthCoalescer<T> {
  readonly #refresh: ReauthRefresh<T>
  #inflight: InflightReauth<T> | null = null

  /**
   * Creates a new reauthorization coalescer.
   *
   * @param refresh - The callback that performs one shared refresh.
   */
  constructor(refresh: ReauthRefresh<T>) {
    this.#refresh = refresh
  }

  /**
   * Runs or joins the current refresh.
   *
   * @param signal - Optional abort signal for this waiter.
   *
   * @returns The shared refresh result.
   */
  run(signal?: AbortSignal): Promise<T> {
    throwIfSignalAborted(signal)
    const inflight = this.#inflight ?? this.start()
    inflight.waiters += 1
    return raceWithAbort(inflight.promise, signal).finally(() => {
      inflight.waiters -= 1
      if (inflight.waiters === 0 && !inflight.settled && !inflight.controller.signal.aborted) {
        inflight.controller.abort(signal?.aborted === true ? abortReason(signal) : undefined)
      }
    })
  }

  private start(): InflightReauth<T> {
    const controller = new AbortController()
    const promise = raceWithAbort(this.#refresh(controller.signal), controller.signal).finally(
      () => {
        if (this.#inflight?.controller !== controller) return
        this.#inflight.settled = true
        this.#inflight = null
      },
    )
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
