import { assertPathInsideRoot, hasErrorCode } from './path-safety.ts'

type DeviceStat = { readonly dev: number | bigint }
type DeviceStatFn = (path: string) => Promise<DeviceStat>

/** @internal */
export const DOWNLOAD_STAGING_DIRECTORY_NAME = '.b2sdk-download-staging'
/** @internal */
export const DOWNLOAD_STAGING_MARKER_NAME = '.b2sdk-staging-marker'

const DOWNLOAD_STAGING_ENTRY_SUFFIX = '.download'
const STALE_DOWNLOAD_STAGING_AGE_MS = 24 * 60 * 60 * 1000
const MAX_STAGING_CLEANUP_CONCURRENCY = 8
const reapedManagedDirectories = new Map<string, Promise<void>>()

/**
 * Creates a private SDK-managed staging directory under a local sync root.
 * @param rootRealPath - Resolved local sync root path.
 * @param path - Node path module used for platform-specific path operations.
 * @param randomUUID - UUID provider used to create unique staging entries.
 * @param statForDeviceCheck - Stat function used to verify filesystem devices.
 *
 * @returns The resolved staging directory path.
 *
 * @internal
 */
export async function createDownloadStagingDirectory(
  rootRealPath: string,
  path: typeof import('node:path'),
  randomUUID: () => string,
  statForDeviceCheck: DeviceStatFn,
): Promise<string> {
  const { chmod, mkdir, readdir, realpath, rm } = await import('node:fs/promises')
  const managedDirectory = path.join(rootRealPath, DOWNLOAD_STAGING_DIRECTORY_NAME)
  await mkdir(managedDirectory, { mode: PRIVATE_DOWNLOAD_DIRECTORY_MODE, recursive: true })
  /* v8 ignore next -- best-effort chmod */
  await chmod(managedDirectory, PRIVATE_DOWNLOAD_DIRECTORY_MODE).catch(() => {})
  const realManagedDirectory = await realpath(managedDirectory)
  assertPathInsideRoot(rootRealPath, realManagedDirectory, path)
  await assertDownloadPathSameDevice(
    rootRealPath,
    realManagedDirectory,
    statForDeviceCheck,
    'unsafe local destination path: cannot stage download across filesystems',
  )

  if (!(await isManagedDownloadStagingRoot(realManagedDirectory))) {
    const entries = await readdir(realManagedDirectory)
    if (entries.length > 0 && !(await isManagedDownloadStagingRoot(realManagedDirectory))) {
      throw new Error(
        `unsafe local destination path: ${DOWNLOAD_STAGING_DIRECTORY_NAME} is reserved for SDK download staging`,
      )
    }
  }
  await writeStagingMarker(realManagedDirectory, path)
  await reapStaleDownloadStagingDirectoriesOnce(realManagedDirectory, path, Date.now())

  const stagingDirectory = path.join(
    realManagedDirectory,
    `${Date.now()}-${randomUUID()}${DOWNLOAD_STAGING_ENTRY_SUFFIX}`,
  )
  await mkdir(stagingDirectory, { mode: PRIVATE_DOWNLOAD_DIRECTORY_MODE })
  /* v8 ignore next -- best-effort chmod */
  await chmod(stagingDirectory, PRIVATE_DOWNLOAD_DIRECTORY_MODE).catch(() => {})
  try {
    const realStagingDirectory = await realpath(stagingDirectory)
    assertPathInsideRoot(realManagedDirectory, realStagingDirectory, path)
    await assertDownloadPathSameDevice(
      rootRealPath,
      realStagingDirectory,
      statForDeviceCheck,
      'unsafe local destination path: cannot stage download across filesystems',
    )
    await writeStagingMarker(realStagingDirectory, path)
    return realStagingDirectory
  } catch (err) {
    /* v8 ignore next -- best-effort cleanup */
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/**
 * Returns true when a scan-root entry is an SDK-managed download staging root.
 * @param directory - Candidate directory to inspect.
 *
 * @returns True when the directory contains SDK staging markers.
 *
 * @internal
 */
export async function isManagedDownloadStagingRoot(directory: string): Promise<boolean> {
  const { lstat, readdir } = await import('node:fs/promises')
  const path = await import('node:path')

  try {
    const markerStats = await lstat(path.join(directory, DOWNLOAD_STAGING_MARKER_NAME))
    if (markerStats.isFile()) return true
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) return false
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(DOWNLOAD_STAGING_ENTRY_SUFFIX)) continue
    try {
      const markerStats = await lstat(
        path.join(directory, entry.name, DOWNLOAD_STAGING_MARKER_NAME),
      )
      if (markerStats.isFile()) return true
    } catch {
      // Keep checking siblings; one corrupt entry should not hide user content.
    }
  }
  return false
}

const PRIVATE_DOWNLOAD_FILE_MODE = 0o600
const PRIVATE_DOWNLOAD_DIRECTORY_MODE = 0o700

async function writeStagingMarker(
  directory: string,
  path: typeof import('node:path'),
): Promise<void> {
  const { chmod, writeFile } = await import('node:fs/promises')
  const markerPath = path.join(directory, DOWNLOAD_STAGING_MARKER_NAME)
  await writeFile(markerPath, '', { flag: 'a', mode: PRIVATE_DOWNLOAD_FILE_MODE })
  /* v8 ignore next -- best-effort chmod */
  await chmod(markerPath, PRIVATE_DOWNLOAD_FILE_MODE).catch(() => {})
}

/**
 * Verifies that a candidate path is on the same filesystem device as the root.
 * @param rootRealPath - Resolved local sync root path.
 * @param candidateRealPath - Resolved candidate path to compare.
 * @param statForDeviceCheck - Stat function used to read device IDs.
 * @param message - Error message used when devices differ.
 *
 * @internal
 */
export async function assertDownloadPathSameDevice(
  rootRealPath: string,
  candidateRealPath: string,
  statForDeviceCheck: DeviceStatFn,
  message: string,
): Promise<void> {
  const [rootStats, candidateStats] = await Promise.all([
    statForDeviceCheck(rootRealPath),
    statForDeviceCheck(candidateRealPath),
  ])
  if (rootStats.dev !== candidateStats.dev) throw new Error(message)
}

async function reapStaleDownloadStagingDirectoriesOnce(
  managedDirectory: string,
  path: typeof import('node:path'),
  nowMillis: number,
): Promise<void> {
  const previous = reapedManagedDirectories.get(managedDirectory)
  if (previous !== undefined) {
    await previous
    return
  }

  const next = reapStaleDownloadStagingDirectories(managedDirectory, path, nowMillis).finally(
    () => {
      if (reapedManagedDirectories.get(managedDirectory) === next) {
        reapedManagedDirectories.delete(managedDirectory)
      }
    },
  )
  reapedManagedDirectories.set(managedDirectory, next)
  await next
}

async function reapStaleDownloadStagingDirectories(
  managedDirectory: string,
  path: typeof import('node:path'),
  nowMillis: number,
): Promise<void> {
  const { lstat, readdir, realpath, rm } = await import('node:fs/promises')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(managedDirectory, { withFileTypes: true })
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return
    emitCleanupWarning(`failed to inspect B2 SDK download staging entries: ${errorMessage(err)}`)
    return
  }

  const cleanupErrors: string[] = []
  await forEachWithConcurrency(entries, MAX_STAGING_CLEANUP_CONCURRENCY, async (entry) => {
    if (!entry.isDirectory() || !entry.name.endsWith(DOWNLOAD_STAGING_ENTRY_SUFFIX)) return
    const candidate = path.join(managedDirectory, entry.name)
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      const markerStats = await lstat(path.join(candidate, DOWNLOAD_STAGING_MARKER_NAME))
      if (!markerStats.isFile()) return
      stats = await lstat(candidate)
    } catch {
      return
    }
    if (nowMillis - stats.mtimeMs < STALE_DOWNLOAD_STAGING_AGE_MS) return
    const realCandidate = await realpath(candidate).catch((err: unknown) => {
      cleanupErrors.push(`${candidate}: ${errorMessage(err)}`)
      return undefined
    })
    if (realCandidate === undefined) return
    try {
      assertPathInsideRoot(managedDirectory, realCandidate, path)
      await rm(realCandidate, { recursive: true, force: true })
    } catch (err) {
      cleanupErrors.push(`${candidate}: ${errorMessage(err)}`)
    }
  })

  if (cleanupErrors.length > 0) {
    const noun = cleanupErrors.length === 1 ? 'entry' : 'entries'
    emitCleanupWarning(
      `failed to reap ${cleanupErrors.length} stale B2 SDK download staging ${noun}: ${cleanupErrors
        .slice(0, 3)
        .join('; ')}`,
    )
  }
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      if (item !== undefined) await fn(item)
    }
  })
  await Promise.all(workers)
}

function emitCleanupWarning(message: string): void {
  const processLike = (
    globalThis as {
      process?: {
        emitWarning?: (warning: string, options?: { readonly code?: string }) => void
      }
    }
  ).process
  processLike?.emitWarning?.(message, { code: 'B2SDK_DOWNLOAD_STAGING_CLEANUP_FAILED' })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
