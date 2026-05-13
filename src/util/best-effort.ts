/**
 * Runs an async cleanup operation and swallows any rejection.
 *
 * Used at error-handling boundaries (e.g. after a multipart upload fails,
 * when trying to `cancelLargeFile` on the orphaned upload). The primary
 * error is what the caller wants to see; a secondary failure during
 * cleanup must not shadow it.
 *
 * Naming the pattern instead of inlining a try/catch with an empty catch
 * makes the intent explicit at the call site: this is best-effort cleanup,
 * not a silent error swallow.
 *
 * @param fn - Cleanup async function. Its return value is ignored; any
 *   thrown error or rejected promise is caught and discarded.
 *
 * @returns A promise that always resolves, regardless of `fn`'s outcome.
 *
 * @example
 * ```ts
 * try {
 *   await uploadParts(...)
 * } catch (err) {
 *   await bestEffort(() =>
 *     raw.cancelLargeFile(apiUrl, authToken, { fileId: largeFileId }),
 *   )
 *   throw err
 * }
 * ```
 */
export async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch {
    // Intentional swallow: this helper exists for cleanup paths where a
    // secondary failure must not shadow the primary error.
  }
}
