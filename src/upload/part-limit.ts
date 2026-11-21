/** Maximum number of parts accepted for a B2 large file. */
export const MAX_LARGE_FILE_PARTS = 10_000

/**
 * Rejects a multipart transfer that would exceed the B2 part limit.
 * @param count - Number of parts required by the transfer.
 * @throws `RangeError` when the count exceeds the service limit.
 */
export function assertPartLimit(count: number): void {
  if (count > MAX_LARGE_FILE_PARTS) {
    throw new RangeError(`A large file cannot exceed ${MAX_LARGE_FILE_PARTS} parts.`)
  }
}
