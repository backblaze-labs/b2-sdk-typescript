import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { LargeFileId } from '../types/ids.ts'
import { bestEffort } from '../util/best-effort.ts'

/** Default wall-clock bound for best-effort cleanup calls after upload failure. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000

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
    const request = raw.cancelLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      { fileId },
      options,
    )
    await waitForCleanup(request, options?.signal)
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
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (signal === undefined || signal.aborted) return { signal: timeoutSignal }
  return { signal: AbortSignal.any([signal, timeoutSignal]) }
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
    void request.catch(() => {})
  }
}

function cleanupAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Cleanup aborted', 'AbortError')
}
