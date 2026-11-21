import type { AccountInfo } from '../auth/account-info.ts'

/**
 * Discard available part URLs after the corresponding large file is finalized.
 * @param accountInfo - Store containing the part URL pool.
 * @param fileId - Finalized large file ID.
 */
export function discardPartUploadUrls(accountInfo: AccountInfo, fileId: string): void {
  // A custom store's cleanup must not mask the outcome of a completed request.
  try {
    // Bound calls even if a custom store repeatedly returns a checked-out URL.
    for (let count = 0; count < 10_000; count++) {
      if (accountInfo.checkoutPartUploadUrl(fileId) == null) return
      // Checkout removes the entry; it must not be returned to the pool.
    }
  } catch {
    // Custom stores own their cleanup behavior.
  }
}
