import type { AccountInfo } from '../auth/account-info.ts'

interface ActiveParts {
  count: number
  finalized: boolean
}

const activeParts = new WeakMap<AccountInfo, Map<string, ActiveParts>>()

/**
 * Tracks only pending part uploads so completed file IDs do not accumulate.
 * @param accountInfo - Store containing the part URL pool.
 * @param fileId - Large file being uploaded.
 * @returns Finalization state and a release callback for this upload.
 */
export function trackPartUpload(
  accountInfo: AccountInfo,
  fileId: string,
): {
  isFinalized: () => boolean
  release: () => void
} {
  let files = activeParts.get(accountInfo)
  if (files === undefined) {
    files = new Map()
    activeParts.set(accountInfo, files)
  }
  let state = files.get(fileId)
  if (state === undefined) {
    state = { count: 0, finalized: false }
    files.set(fileId, state)
  }
  const tracked = state
  const trackedFiles = files
  tracked.count++
  return {
    isFinalized: () => tracked.finalized,
    release: () => {
      tracked.count--
      if (tracked.count === 0) {
        trackedFiles.delete(fileId)
        if (trackedFiles.size === 0) activeParts.delete(accountInfo)
      }
    },
  }
}

/**
 * Discard available part URLs after the corresponding large file is finalized.
 * @param accountInfo - Store containing the part URL pool.
 * @param fileId - Finalized large file ID.
 */
export function discardPartUploadUrls(accountInfo: AccountInfo, fileId: string): void {
  const active = activeParts.get(accountInfo)?.get(fileId)
  if (active !== undefined) active.finalized = true
  // A custom store's cleanup must not mask the outcome of a completed request.
  try {
    // This cleanup work bound prevents a broken custom store from looping forever;
    // it is not a limit on the number of parts in an upload.
    for (let count = 0; count < 10_000; count++) {
      if (accountInfo.checkoutPartUploadUrl(fileId) == null) return
      // Checkout removes the entry; it must not be returned to the pool.
    }
  } catch {
    // Custom stores own their cleanup behavior.
  }
}
