/**
 * Abort-signal helpers shared by the HTTP transport and Partner client.
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
 * @param promise - The work to await.
 * @param signal - Abort signal, or undefined to await the promise directly.
 *
 * @returns The resolved value of `promise` when it settles before the signal aborts.
 */
export async function racePromiseWithAbort<T>(
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
  })

  try {
    return await Promise.race([promise, aborted])
  } finally {
    removeAbortListener?.()
  }
}
