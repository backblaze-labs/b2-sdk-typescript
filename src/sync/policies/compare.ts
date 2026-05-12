import type { CompareMode, SyncPath } from '../types.js'

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
