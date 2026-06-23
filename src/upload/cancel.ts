import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { LargeFileId } from '../types/ids.ts'
import { bestEffort } from '../util/best-effort.ts'

/** Default wall-clock bound for best-effort cleanup calls after upload failure. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000

const fallbackCleanupDisposers = new WeakMap<AbortSignal, () => void>()

/**
 * Cancels an unfinished large file on a best-effort basis. Used at every
 * error-handling boundary in the multipart upload, write-stream, and
 * server-side copy paths to roll back in-progress uploads without
 * letting a cancellation failure mask the underlying error the caller
 * is about to see.
 *
 * Centralising the call removes a five-line `bestEffort` block that
 * recurred at six sites with identical shape — the only thing that
 * changed was the captured `fileId` and the surrounding error trail.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state for the API URL + token.
 * @param fileId - The in-progress large file ID to cancel.
 * @param options - Optional request controls for bounding the cleanup call.
 *
 * @returns A promise that always resolves, regardless of the cancel
 *   call's outcome.
 */
export async function cancelLargeFileBestEffort(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  options?: { readonly signal?: AbortSignal },
): Promise<void> {
  await bestEffort(async () => {
    const requestOptions =
      options?.signal !== undefined ? options : cleanupRequestOptions(undefined)
    const request = raw.cancelLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      { fileId },
      requestOptions,
    )
    await waitForCleanup(request, requestOptions.signal)
  })
}

/**
 * Returns cleanup request controls with a live timeout signal.
 *
 * @param signal - Caller-provided abort signal, if any.
 * @param timeoutMs - Maximum time to spend waiting for cleanup.
 *
 * @returns Request controls with a signal independent of an already-aborted caller signal.
 */
export function cleanupRequestOptions(
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
): { readonly signal: AbortSignal } {
  return { signal: createCleanupSignal(signal, timeoutMs) }
}

function createCleanupSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') {
    if (signal === undefined || signal.aborted) return AbortSignal.timeout(timeoutMs)
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    }
  }

  return createFallbackCleanupSignal(signal, timeoutMs)
}

function createFallbackCleanupSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    abortFallbackCleanup(controller, cleanupTimeoutReason(), cleanup)
  }, timeoutMs)

  const onAbort = () => {
    const reason =
      signal === undefined
        ? cleanupDomException('Cleanup aborted', 'AbortError')
        : cleanupAbortReason(signal)
    abortFallbackCleanup(controller, reason, cleanup)
  }
  const cleanup = () => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
    fallbackCleanupDisposers.delete(controller.signal)
  }
  fallbackCleanupDisposers.set(controller.signal, cleanup)

  if (signal === undefined || signal.aborted) {
    return controller.signal
  }

  signal.addEventListener('abort', onAbort, { once: true })
  controller.signal.addEventListener('abort', cleanup, { once: true })
  return controller.signal
}

function abortFallbackCleanup(
  controller: AbortController,
  reason: unknown,
  cleanup: () => void,
): void {
  if (!controller.signal.aborted) controller.abort(reason)
  cleanup()
}

async function waitForCleanup(
  request: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await request
    return
  }
  if (signal.aborted) throw cleanupAbortReason(signal)

  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(cleanupAbortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    await Promise.race([request, aborted])
  } finally {
    removeAbortListener?.()
    fallbackCleanupDisposers.get(signal)?.()
    void request.catch(() => {})
  }
}

function cleanupAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? cleanupDomException('Cleanup aborted', 'AbortError')
}

function cleanupTimeoutReason(): unknown {
  return cleanupDomException('Cleanup timed out', 'TimeoutError')
}

function cleanupDomException(message: string, name: string): Error {
  if (typeof DOMException === 'function') return new DOMException(message, name)
  const error = new Error(message)
  error.name = name
  return error
}
