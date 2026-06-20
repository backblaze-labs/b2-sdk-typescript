import type { SyncScanOptions, SyncSkipEvent } from './types.ts'

/**
 * Emits a scanner skip event without letting observer failures abort the scan.
 *
 * @param filters - Scan options that may include an onSkip callback.
 * @param event - Skip event to report.
 */
export function emitScannerSkip(filters: SyncScanOptions | undefined, event: SyncSkipEvent): void {
  try {
    filters?.onSkip?.(event)
  } catch {
    // Diagnostics hooks must not change scan behavior.
  }
}

/**
 * Builds a consistent skip event for paths that cannot be safely tested against RegExp filters.
 *
 * @param relativePath - Sync-relative path that exceeded the RegExp input limit.
 *
 * @returns A typed scanner skip event.
 */
export function regexpInputTooLongSkip(relativePath: string): SyncSkipEvent {
  return {
    type: 'skip',
    path: relativePath,
    size: 0,
    message: `Skipped sync path ${JSON.stringify(
      relativePath,
    )}: path exceeds the RegExp filter input limit`,
    reason: 'path-too-long-for-regexp',
  }
}
