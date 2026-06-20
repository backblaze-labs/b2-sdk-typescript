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
