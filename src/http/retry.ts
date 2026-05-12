export interface RetryOptions {
  readonly maxRetries: number
  readonly maxRetryDelayMs: number
  readonly initialRetryDelayMs: number
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 5,
  maxRetryDelayMs: 64_000,
  initialRetryDelayMs: 1_000,
}

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
