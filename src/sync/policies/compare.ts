import type { B2SyncPath, CompareMode, SyncPath } from '../types.ts'

const sha1HexPattern = /^[0-9a-f]{40}$/i

/**
 * Determines whether two files should be considered different based on the compare mode.
 *
 * @param source - The source file metadata.
 * @param dest - The destination file metadata.
 * @param compareMode - The comparison strategy: 'modtime', 'size', 'sha1', or 'none'.
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
    case 'sha1':
      return sha1ValuesAreDifferent(source, dest)
    case 'modtime':
      return Math.abs(source.modTimeMillis - dest.modTimeMillis) > threshold
  }
}

function sha1ValuesAreDifferent(source: SyncPath, dest: SyncPath): boolean {
  const sourceSha1 = comparableSha1(source)
  const destSha1 = comparableSha1(dest)
  if (sourceSha1 === null || destSha1 === null) return true
  return sourceSha1 !== destSha1
}

function comparableSha1(path: SyncPath): string | null {
  const sha1 = path.contentSha1 ?? (isB2SyncPath(path) ? path.selectedVersion.contentSha1 : null)
  if (!sha1HexPattern.test(sha1 ?? '')) return null
  return sha1?.toLowerCase() ?? null
}

function isB2SyncPath(path: SyncPath): path is B2SyncPath {
  return 'selectedVersion' in path
}
