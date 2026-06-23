import type { AccountInfo } from '../auth/account-info.ts'
import { FinishLargeFileResponseBodyError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'

/** Context for safely finalizing a large file. */
export interface FinishLargeFileContext {
  readonly fileId: LargeFileId
  readonly bucketId: BucketId
  readonly fileName: string
  readonly partSha1s: readonly string[]
  readonly signal?: AbortSignal
  readonly retry?: Partial<RetryOptions>
}

/**
 * Calls `b2_finish_large_file` and classifies failures after dispatch that can
 * hide an already-committed file as ambiguous finish failures.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param context - Finish request data and reconciliation metadata.
 *
 * @returns The completed file version metadata.
 */
export async function finishLargeFileWithAbortReconciliation(
  raw: RawClient,
  accountInfo: AccountInfo,
  context: FinishLargeFileContext,
): Promise<FileVersion> {
  context.signal?.throwIfAborted()
  try {
    return await raw.finishLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      {
        fileId: context.fileId,
        partSha1Array: context.partSha1s,
      },
      context.signal === undefined && context.retry === undefined
        ? undefined
        : {
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
            ...(context.retry !== undefined ? { retry: context.retry } : {}),
          },
    )
  } catch (err) {
    if (isAbortOrTimeoutAfterFinishDispatch(err, context.signal)) {
      throw new FinishLargeFileResponseBodyError(
        'b2_finish_large_file failed after dispatch; final file state is ambiguous.',
        {
          cause: err,
          fileId: context.fileId,
          bucketId: context.bucketId,
          fileName: context.fileName,
        },
      )
    }
    throw err
  }
}

function isAbortOrTimeoutAfterFinishDispatch(
  err: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (isTimeoutError(err)) return true
  if (signal?.aborted !== true) return false
  if (signal.reason !== undefined && Object.is(err, signal.reason)) return true
  return isAbortError(err)
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

function isTimeoutError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'TimeoutError') ||
    (err instanceof Error && err.name === 'TimeoutError')
  )
}
