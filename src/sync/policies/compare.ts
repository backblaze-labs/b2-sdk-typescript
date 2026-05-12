import type { CompareMode, SyncPath } from '../types.js'

/**
 * Determines whether two files should be considered different based on the compare mode.
 *
 * @param source - The source file metadata.
 * @param dest - The destination file metadata.
 * @param compareMode - The comparison strategy: 'modtime', 'size', or 'none'.
 * @param threshold - Tolerance for the comparison (bytes for size, milliseconds for modtime).
 *
 * @returns `true` if the files are considered different.
 */
export function filesAreDifferent(
  source: SyncPath,
  dest: SyncPath,
  compareMode: CompareMode,
  threshold = 0,
): boolean {
  switch (compareMode) {
    case 'none':
      return false
    case 'size':
      return Math.abs(source.size - dest.size) > threshold
    case 'modtime':
      return Math.abs(source.modTimeMillis - dest.modTimeMillis) > threshold
  }
}
