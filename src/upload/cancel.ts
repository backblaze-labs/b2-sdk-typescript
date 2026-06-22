import type { AccountInfo } from '../auth/account-info.ts'
import { FinishLargeFileResponseBodyError } from '../errors/index.ts'
import type { RawClient } from '../raw/index.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { bestEffort } from '../util/best-effort.ts'

/** Event emitted when best-effort `b2_cancel_large_file` cleanup fails. */
export interface CancelLargeFileCleanupFailureEvent {
  /** Unfinished large file that may remain orphaned. */
  readonly fileId: LargeFileId
  /** Error thrown by `b2_cancel_large_file`. */
  readonly error: unknown
  /** Cleanup phase that produced the observable event. */
  readonly reason: 'cancel-failed'
}

/** Event emitted when cleanup is skipped because finish may have committed. */
export interface AmbiguousFinishCleanupFailureEvent {
  /** Large file whose final server-side state is ambiguous. */
  readonly fileId: LargeFileId
  /** Error thrown to the caller with reconciliation metadata. */
  readonly error: FinishLargeFileResponseBodyError
  /** Cleanup phase that produced the observable event. */
  readonly reason: 'finish-ambiguous'
}

/** Event emitted when large-file cleanup fails or is deliberately skipped. */
export type CleanupFailureEvent =
  | CancelLargeFileCleanupFailureEvent
  | AmbiguousFinishCleanupFailureEvent

/** Callback invoked when best-effort cleanup fails. */
export type CleanupFailureListener = (event: CleanupFailureEvent) => void

/** Shared option for observing large-file cleanup failures or skipped cleanup. */
export interface CleanupFailureOptions {
  /**
   * Callback invoked if best-effort cancellation fails, or if cancellation is
   * skipped because `b2_finish_large_file` may already have committed.
   */
  readonly onCleanupFailure?: CleanupFailureListener
}

/** Default wall-clock bound for best-effort cleanup calls after upload failure. */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000

const fallbackCleanupDisposers = new WeakMap<AbortSignal, () => void>()

/** Context needed to reconcile or cancel an unfinished large file after an error. */
export interface LargeFileCleanupContext {
  readonly fileId: LargeFileId
  readonly bucketId: BucketId
  readonly fileName: string
  readonly signal?: AbortSignal | undefined
  readonly onCleanupFailure?: CleanupFailureListener | undefined
}

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
 * @param options - Optional request controls and cleanup-failure observer.
 *
 * @returns A promise that always resolves, regardless of the cancel
 *   call's outcome.
 */
export async function cancelLargeFileBestEffort(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  options?: { readonly signal?: AbortSignal } & CleanupFailureOptions,
): Promise<void> {
  await bestEffort(
    async () => {
      const requestOptions = cleanupRequestOptions(options?.signal)
      const request = raw.cancelLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        { fileId },
        requestOptions,
      )
      await waitForCleanup(request, requestOptions.signal)
    },
    (error) => options?.onCleanupFailure?.({ fileId, error, reason: 'cancel-failed' }),
  )
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

async function waitForCleanup(request: Promise<unknown>, signal: AbortSignal): Promise<void> {
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

/**
 * Emits an observable cleanup event when cancellation is deliberately skipped
 * because `b2_finish_large_file` may already have committed the file.
 * @param fileId - Large file whose final state is ambiguous.
 * @param error - Ambiguous finish error that will be thrown to the caller.
 * @param onCleanupFailure - Optional observer for cleanup-related events.
 */
export function notifyAmbiguousLargeFileCleanupSkipped(
  fileId: LargeFileId,
  error: FinishLargeFileResponseBodyError,
  onCleanupFailure?: CleanupFailureListener,
): void {
  try {
    onCleanupFailure?.({ fileId, error, reason: 'finish-ambiguous' })
  } catch {
    // Observer failures are secondary and must not hide the finish ambiguity.
  }
}

/**
 * Adds high-level reconciliation metadata to an ambiguous finish response-body
 * error and notifies the cleanup observer that cancellation was skipped.
 *
 * @param err - Raw finish response-body error from the low-level client.
 * @param options - Large-file context used for reconciliation.
 *
 * @returns The enriched {@link FinishLargeFileResponseBodyError}.
 */
export function handleAmbiguousFinishLargeFileResponseBodyError(
  err: FinishLargeFileResponseBodyError,
  options: LargeFileCleanupContext,
): FinishLargeFileResponseBodyError {
  const enriched =
    err.fileId === options.fileId &&
    err.bucketId === options.bucketId &&
    err.fileName === options.fileName
      ? err
      : new FinishLargeFileResponseBodyError(err.message, {
          cause: err.cause ?? err,
          fileId: options.fileId,
          bucketId: options.bucketId,
          fileName: options.fileName,
        })
  notifyAmbiguousLargeFileCleanupSkipped(options.fileId, enriched, options.onCleanupFailure)
  return enriched
}

/**
 * Performs the shared large-file failure policy: ambiguous finish-body errors
 * are enriched and left uncancelled, while all pre-finish errors trigger
 * best-effort cancellation.
 *
 * @param err - Error from a multipart upload/copy/write-stream path.
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param context - Large file metadata used for cleanup and diagnostics.
 *
 * @returns The error that should be surfaced to the caller.
 */
export async function resolveLargeFileErrorAfterCleanup(
  err: unknown,
  raw: RawClient,
  accountInfo: AccountInfo,
  context: LargeFileCleanupContext,
): Promise<unknown> {
  if (err instanceof FinishLargeFileResponseBodyError) {
    return handleAmbiguousFinishLargeFileResponseBodyError(err, context)
  }
  await cancelLargeFileBestEffort(raw, accountInfo, context.fileId, {
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
    ...(context.onCleanupFailure !== undefined
      ? { onCleanupFailure: context.onCleanupFailure }
      : {}),
  })
  return err
}

/**
 * Throwing wrapper around {@link resolveLargeFileErrorAfterCleanup} for paths
 * that can surface the error directly.
 */
export async function cleanupAfterLargeFileError(
  err: unknown,
  raw: RawClient,
  accountInfo: AccountInfo,
  context: LargeFileCleanupContext,
): Promise<never> {
  throw await resolveLargeFileErrorAfterCleanup(err, raw, accountInfo, context)
}
