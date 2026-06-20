const syncPathCollator = new Intl.Collator('en-US', {
  numeric: false,
  sensitivity: 'variant',
  usage: 'sort',
})

/**
 * Compares sync-relative paths using the same fixed collation everywhere sorted scans are consumed.
 *
 * @param left - First sync-relative path.
 * @param right - Second sync-relative path.
 *
 * @returns Negative, zero, or positive using the SDK scan collation.
 */
export function compareSyncRelativePaths(left: string, right: string): number {
  const result = syncPathCollator.compare(left, right)
  return result === 0 && left !== right ? compareCodeUnits(left, right) : result
}

/** Backwards-compatible alias for the SDK scan collation. */
export function compareSyncPathNames(a: string, b: string): number {
  return compareSyncRelativePaths(a, b)
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  /* v8 ignore next -- compareSyncRelativePaths only calls this for distinct strings. */
  return 0
}
