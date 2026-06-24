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
 * @param options - Platform and ctime comparison overrides for controlled filesystem moves.
 *
 * @throws If the current file is not the scanned regular file.
 *
 * @internal
 */
export function assertSameScannedRegularFile(
  stats: LocalRegularFileStatsLike,
  path: LocalSyncPath,
  operation: 'upload' | 'download' | 'delete' | 'sha1 comparison' = 'upload',
  options: {
    readonly compareChangeTime?: boolean | undefined
    readonly platform?: string | undefined
  } = {},
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

  if (
    !sameLocalIdentity(stats, identity, {
      compareChangeTime: options.compareChangeTime,
      platform: options.platform ?? currentPlatform(),
    })
  ) {
    throw new Error(reason)
  }
}

function sameLocalIdentity(
  stats: LocalFileStatsLike,
  identity: LocalFileIdentity,
  options: {
    readonly compareChangeTime?: boolean | undefined
    readonly platform: string | undefined
  },
): boolean {
  const compareChangeTime =
    options.compareChangeTime ?? shouldComparePosixChangeTime(options.platform)
  return (
    (!shouldComparePosixFileIdentity(options.platform) ||
      (stats.dev === identity.deviceId && stats.ino === identity.inode)) &&
    stats.size === identity.size &&
    Math.floor(stats.mtimeMs) === identity.modTimeMillis &&
    (!compareChangeTime ||
      identity.changeTimeMillis === undefined ||
      Math.floor(stats.ctimeMs) === identity.changeTimeMillis)
  )
}

function shouldComparePosixFileIdentity(platform: string | undefined): boolean {
  return platform !== 'win32'
}

function shouldComparePosixChangeTime(platform: string | undefined): boolean {
  return platform !== 'win32'
}

function currentPlatform(): string | undefined {
  const processLike = (globalThis as { process?: { platform?: string } }).process
  return processLike?.platform
}
