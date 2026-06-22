/** Default idle/no-progress timeout for SHA-1 reads. */
export const DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS = 30_000

/** Default absolute deadline for one untrusted B2 SHA-1 verification read. */
export const DEFAULT_SHA1_VERIFICATION_TIMEOUT_MILLIS = 300_000

/**
 * Normalizes a user-provided SHA-1 timeout value.
 *
 * @param value - Optional timeout in milliseconds.
 * @param defaultValue - Default timeout when the value is missing or invalid.
 *
 * @returns A positive integer timeout in milliseconds.
 */
export function normalizeSha1TimeoutMillis(
  value: number | undefined,
  defaultValue = DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return defaultValue
  }
  return Math.floor(value)
}
