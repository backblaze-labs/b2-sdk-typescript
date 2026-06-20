/** Configuration for retry behavior on transient failures. */
export interface RetryOptions {
  /** Maximum number of retry attempts before giving up. */
  readonly maxRetries: number
  /** Upper bound on retry delay in milliseconds, regardless of backoff calculation. */
  readonly maxRetryDelayMs: number
  /** Base delay in milliseconds for the first retry. Doubles on each subsequent attempt. */
  readonly initialRetryDelayMs: number
  /**
   * Absolute deadline for each HTTP request attempt. Set to 0 to disable the
   * SDK timeout and rely only on the caller's AbortSignal.
   */
  readonly requestTimeoutMs: number
}

/** Default retry settings: 5 retries, 1s initial delay, 64s max delay, 15 minute attempt timeout. */
export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  maxRetryDelayMs: 64_000,
  initialRetryDelayMs: 1_000,
  requestTimeoutMs: 15 * 60_000,
}

/**
 * Computes the delay before the next retry using exponential backoff with jitter.
 * If a `Retry-After` value is provided by the server, it takes precedence over
 * the calculated backoff (still capped at {@link RetryOptions.maxRetryDelayMs}).
 *
 * @param attempt - Zero-based retry attempt index.
 * @param options - Retry configuration with delay bounds.
 * @param retryAfter - Server-provided retry delay in seconds, if any.
 *
 * @returns The delay in milliseconds before the next retry attempt.
 */
export function computeBackoff(
  attempt: number,
  options: RetryOptions,
  retryAfter?: number,
): number {
  if (retryAfter !== undefined && retryAfter > 0) {
    return Math.min(retryAfter * 1000, options.maxRetryDelayMs)
  }
  const base = options.initialRetryDelayMs * 2 ** attempt
  const jitter = Math.random() * base * 0.5
  return Math.min(base + jitter, options.maxRetryDelayMs)
}

/**
 * Returns a promise that resolves after the given delay. Supports cancellation
 * via an optional AbortSignal.
 *
 * @param ms - Delay in milliseconds.
 * @param signal - Optional abort signal to cancel the sleep early.
 *
 * @returns A promise that resolves when the delay elapses or rejects if aborted.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}
