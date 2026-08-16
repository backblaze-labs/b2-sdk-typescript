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
