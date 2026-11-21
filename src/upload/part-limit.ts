/**
 * Maximum number of parts accepted for a B2 large file.
 * @see https://www.backblaze.com/docs/cloud-storage-create-large-files-with-the-native-api
 */
export const MAX_LARGE_FILE_PARTS = 10_000

/** Identifies the part-limit reason when closing an already-errored upload stream. */
export class PartLimitError extends RangeError {
  /** Creates the shared error for a multipart transfer above the service limit. */
  constructor() {
    super(`A large file cannot exceed ${MAX_LARGE_FILE_PARTS} parts.`)
  }
}

/**
 * Rejects a multipart transfer that would exceed the B2 part limit.
 * @param count - Number of parts required by the transfer.
 *
 * @throws `RangeError` when the count exceeds the service limit.
 */
export function assertPartLimit(count: number): void {
  if (count > MAX_LARGE_FILE_PARTS) {
    throw new PartLimitError()
  }
}
