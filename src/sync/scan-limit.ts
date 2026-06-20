import type { SyncScanOptions } from './types.ts'

/** Default maximum number of entries a sync scanner may retain before failing. */
export const DEFAULT_MAX_SCAN_ENTRIES = 1_000_000

/**
 * Resolves and validates the effective scan entry limit.
 * @param options - Optional scan options carrying an override.
 *
 * @returns The configured or default scan entry limit.
 *
 * @throws When the configured limit is not a positive safe integer or Infinity.
 */
export function scanEntryLimit(options: SyncScanOptions | undefined): number {
  const limit = options?.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES
  if (limit === Number.POSITIVE_INFINITY) return limit
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('maxScanEntries must be a positive safe integer or Infinity')
  }
  return limit
}

/**
 * Throws when a scanner has retained more entries than the configured limit.
 * @param count - Number of retained entries.
 * @param limit - Maximum allowed retained entries.
 *
 * @throws When count is greater than limit.
 */
export function assertScanEntryLimit(count: number, limit: number): void {
  if (count > limit) {
    throw new Error(`Sync scan entry limit exceeded (${count} > ${limit})`)
  }
}
