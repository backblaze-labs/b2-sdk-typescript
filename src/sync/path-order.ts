/**
 * Compares sync paths with the same ordering that {@link zipFolders} uses.
 *
 * This is JavaScript's deterministic string order, not locale collation.
 * Scanners must use this order so merge-joining can pair paths correctly.
 *
 * @param a - First relative sync path.
 * @param b - Second relative sync path.
 *
 * @returns `-1` when `a` sorts first, `1` when `b` sorts first, otherwise `0`.
 */
export function compareSyncPathNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Compares sync-relative paths using the same collation everywhere sorted scans are consumed.
 *
 * @param left - First sync-relative path.
 * @param right - Second sync-relative path.
 *
 * @returns Negative, zero, or positive using the SDK scan collation.
 */
export function compareSyncRelativePaths(left: string, right: string): number {
  return compareSyncPathNames(left, right)
}
