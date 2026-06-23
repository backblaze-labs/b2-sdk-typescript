/** Internal cancellation scope shared by multipart upload workers. */
export interface UploadAbortScope {
  /** Signal passed to upload requests and checked by queued work. */
  readonly signal: AbortSignal
  /** Abort the shared multipart attempt if it has not already been aborted. */
  abort(reason: unknown): void
  /** Detach any listener installed on the caller-provided signal. */
  dispose(): void
}

/**
 * Creates a child abort signal that can be cancelled either by the caller's
 * signal or by the multipart engine itself after one worker fails.
 *
 * @param upstream - Caller-provided abort signal, if any.
 *
 * @returns A shared abort scope for one multipart attempt.
 */
export function createUploadAbortScope(upstream: AbortSignal | undefined): UploadAbortScope {
  const controller = new AbortController()
  const upstreamSignal = upstream
  let upstreamAbort: (() => void) | undefined
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  if (upstreamSignal?.aborted === true) {
    abort(upstreamSignal.reason)
  } else if (upstreamSignal !== undefined) {
    upstreamAbort = () => abort(upstreamSignal.reason)
    upstreamSignal.addEventListener('abort', upstreamAbort, { once: true })
  }

  return {
    signal: controller.signal,
    abort,
    dispose() {
      if (upstreamAbort !== undefined) upstreamSignal?.removeEventListener('abort', upstreamAbort)
    },
  }
}
