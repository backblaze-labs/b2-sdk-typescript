/**
 * Abort-signal and cancellation-error helpers shared across SDK operations.
 *
 * @packageDocumentation
 */

/**
 * Resolves the abort reason for a signal, defaulting to a standard `AbortError`.
 *
 * @param signal - The aborted signal whose reason should be resolved.
 *
 * @returns The signal's `reason`, or a fresh `AbortError` DOMException when unset.
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/**
 * Returns whether an error represents an abort.
 *
 * @param err - Unknown thrown value.
 *
 * @returns True for `Error` or `DOMException` instances named `AbortError`.
 */
export function isAbortError(err: unknown): boolean {
  return isNamedError(err, 'AbortError')
}

/**
 * Returns whether an error should be treated as the given signal's abort.
 *
 * @param signal - Controlling signal for the operation.
 * @param err - Unknown thrown value.
 *
 * @returns True when the signal is aborted and `err` is either the signal's
 * reason or a trusted `AbortError` instance.
 */
export function isSignalAbortError(signal: AbortSignal | undefined, err: unknown): boolean {
  if (signal?.aborted !== true) return false
  if (signal.reason !== undefined && Object.is(err, signal.reason)) return true
  return isAbortError(err)
}

/**
 * Returns whether an error represents a timeout.
 *
 * @param err - Unknown thrown value.
 *
 * @returns True for `Error` or `DOMException` instances named `TimeoutError`.
 */
export function isTimeoutError(err: unknown): boolean {
  return isNamedError(err, 'TimeoutError')
}

/**
 * Throws the abort reason if the signal is already aborted; otherwise returns.
 *
 * @param signal - The signal to check, or undefined to skip the check.
 *
 * @throws The signal's abort reason when the signal is already aborted.
 */
export function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortReason(signal)
  }
}

/**
 * Races a promise against an abort signal. Rejects with the signal's abort
 * reason if the signal fires first, detaching the listener and suppressing the
 * losing promise's rejection so it never surfaces as an unhandled rejection.
 *
 * The underlying work must still receive the same signal so transports can
 * cancel their network activity. This helper only makes callers stop waiting
 * promptly even when a test double or custom transport ignores the signal.
 *
 * @param promise - The work to await.
 * @param signal - Abort signal, or undefined to await the promise directly.
 *
 * @returns The resolved value of `promise` when it settles before the signal aborts.
 *
 * @throws The abort reason if the signal aborts first, or the promise's rejection.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    void promise.catch(() => {})
    throw abortReason(signal)
  }

  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      void promise.catch(() => {})
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) onAbort()
  })

  try {
    return await Promise.race([promise, aborted])
  } finally {
    removeAbortListener?.()
  }
}

function isNamedError(err: unknown, name: string): boolean {
  try {
    return (
      (err instanceof DOMException || err instanceof Error) &&
      (err as { readonly name: string }).name === name
    )
  } catch {
    return false
  }
}
