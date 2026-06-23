import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { LargeFileId } from '../types/ids.ts'
import { bestEffort } from '../util/best-effort.ts'

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
  await bestEffort(() =>
    raw.cancelLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), { fileId }, options),
  )
}
