/**
 * Compares sync-relative paths using the same code-unit order everywhere sorted scans are consumed.
 *
 * @param left - First sync-relative path.
 * @param right - Second sync-relative path.
 *
 * @returns Negative, zero, or positive using JavaScript code-unit order.
 */
export function compareSyncRelativePaths(left: string, right: string): number {
  return compareCodeUnits(left, right)
}

/**
 * Backwards-compatible alias for the SDK scan ordering.
 *
 * @param a - First sync-relative path.
 * @param b - Second sync-relative path.
 *
 * @returns Negative, zero, or positive using JavaScript code-unit order.
 */
export function compareSyncPathNames(a: string, b: string): number {
  return compareSyncRelativePaths(a, b)
}

/**
 * Compares strings by JavaScript code-unit order.
 *
 * @param left - First string.
 * @param right - Second string.
 *
 * @returns Negative, zero, or positive using code-unit order.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  /* v8 ignore next -- compareSyncRelativePaths only calls this for distinct strings. */
  return 0
}
