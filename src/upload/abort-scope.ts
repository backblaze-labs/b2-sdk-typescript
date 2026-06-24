/** Shared abort scope for multipart work that fans out into concurrent tasks. */
export interface AbortScope {
  /** Signal linked to the caller signal and to task-level failures. */
  readonly signal: AbortSignal
  /** Abort the scope if it has not already been aborted. */
  abort(reason: unknown): void
  /** Detach any upstream abort listener. */
  dispose(): void
}

/**
 * Creates an abort scope linked to an optional upstream signal.
 * Task failures can abort the same scope so sibling tasks stop promptly.
 * @param upstream - Caller-provided abort signal, if any.
 *
 * @returns A linked abort scope.
 */
export function createAbortScope(upstream: AbortSignal | undefined): AbortScope {
  const controller = new AbortController()
  let upstreamAbort: (() => void) | undefined
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  if (upstream?.aborted === true) {
    abort(upstream.reason)
  } else if (upstream !== undefined) {
    upstreamAbort = () => abort(upstream.reason)
    upstream.addEventListener('abort', upstreamAbort, { once: true })
  }

  return {
    signal: controller.signal,
    abort,
    dispose() {
      if (upstreamAbort !== undefined) upstream?.removeEventListener('abort', upstreamAbort)
    },
  }
}

/**
 * Throws the abort reason or first task rejection from a settled task set.
 * @param settled - Results from `Promise.allSettled`.
 * @param abortScope - Scope that coordinated the tasks.
 *
 * @throws The abort reason or first rejected task reason.
 */
export function throwRejectedOrAbortReason(
  settled: readonly PromiseSettledResult<unknown>[],
  abortScope: AbortScope,
): void {
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected === undefined) return
  if (abortScope.signal.aborted && abortScope.signal.reason !== undefined) {
    throw abortScope.signal.reason
  }
  /* v8 ignore next -- Defensive fallback for unexpected task rejections outside the abort scope. */
  throw rejected.reason
}

/**
 * Returns the observable reason for an aborted signal.
 * @param signal - Aborted signal to inspect.
 *
 * @returns The signal's reason, or a standard AbortError when the runtime did not provide one.
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/**
 * Races a request promise against an abort signal.
 *
 * The underlying request must still receive the same signal so transports can
 * cancel their network work. This helper makes callers stop waiting promptly
 * even when a test double or custom transport ignores the signal.
 *
 * @param promise - Request promise to observe.
 * @param signal - Signal that should stop waiting for the request.
 *
 * @returns The request result if it settles before the signal aborts.
 *
 * @throws The abort reason if the signal aborts first, or the request rejection.
 */
export async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    throw abortReason(signal)
  }

  let removeAbortListener: (() => void) | undefined
  const abort = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([promise, abort])
  } catch (err) {
    if (signal.aborted) promise.catch(() => {})
    throw err
  } finally {
    removeAbortListener?.()
  }
}
