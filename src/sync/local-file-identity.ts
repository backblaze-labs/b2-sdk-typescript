import type { LocalFileIdentity, LocalSyncPath } from './types.ts'

interface LocalFileStatsLike {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly size: number
}

interface LocalRegularFileStatsLike extends LocalFileStatsLike {
  isFile(): boolean
}

/**
 * Converts Node file stats into the sync scanner's persisted identity shape.
 * @param stats - Node file stats to convert.
 *
 * @returns The scanner identity stored with a local sync path.
 *
 * @internal
 */
export function localFileIdentityFromStats(stats: LocalFileStatsLike): LocalFileIdentity {
  return {
    deviceId: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modTimeMillis: Math.floor(stats.mtimeMs),
    changeTimeMillis: Math.floor(stats.ctimeMs),
  }
}

/**
 * Verifies that current local stats still match a previously scanned regular file.
 * @param stats - Current filesystem stats for the candidate file.
 * @param path - Previously scanned local sync path.
 * @param operation - Operation name used in mutation diagnostics.
 *
 * @throws If the current file is not the scanned regular file.
 *
 * @internal
 */
export function assertSameScannedRegularFile(
  stats: LocalRegularFileStatsLike,
  path: LocalSyncPath,
  operation: 'upload' | 'delete' | 'sha1 comparison' = 'upload',
): void {
  const reason = `local file changed before ${operation}`
  if (!stats.isFile()) {
    if (operation === 'delete') {
      throw Object.assign(new Error(`${reason}: not a regular file`), { code: 'EISDIR' })
    }
    throw new Error(`${reason}: not a regular file`)
  }
  if (stats.size !== path.size) {
    throw new Error(`${reason}: size changed`)
  }

  const identity = path.fileIdentity
  if (identity === undefined) return

  if (!sameLocalIdentity(stats, identity)) {
    throw new Error(reason)
  }
}

function sameLocalIdentity(stats: LocalFileStatsLike, identity: LocalFileIdentity): boolean {
  return (
    stats.dev === identity.deviceId &&
    stats.ino === identity.inode &&
    stats.size === identity.size &&
    Math.floor(stats.mtimeMs) === identity.modTimeMillis &&
    (identity.changeTimeMillis === undefined ||
      Math.floor(stats.ctimeMs) === identity.changeTimeMillis)
  )
}
