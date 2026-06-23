export const SYNC_DOWNLOAD_TEMP_PREFIX = '.b2sdk-'
export const SYNC_DOWNLOAD_TEMP_SUFFIX = '.partial'
export const DEFAULT_STALE_SYNC_DOWNLOAD_TEMP_MILLIS = 24 * 60 * 60 * 1000

export interface SyncDownloadTempFileSweepEvent {
  readonly action: 'removed-stale' | 'retained-stale'
  readonly directory: string
  readonly name: string
  readonly ageMillis: number
  readonly message: string
}

export interface SyncDownloadTempFileSweepOptions {
  readonly staleMillis?: number
  readonly nowMillis?: () => number
  readonly onEvent?: (event: SyncDownloadTempFileSweepEvent) => void
}

export interface SyncDownloadTempFileSweeper {
  readonly ownerToken: string
  (directory: string): Promise<void>
}

type DirectoryEntry = {
  name: string
  isFile(): boolean
}

interface FileStats {
  readonly mtimeMs: number
}

/**
 * Checks whether a directory entry is an SDK-managed partial download file.
 * @param name - Directory entry basename.
 *
 * @returns True when the name matches the SDK partial-download pattern.
 */
export function isSyncDownloadTempName(name: string): boolean {
  return name.startsWith(SYNC_DOWNLOAD_TEMP_PREFIX) && name.endsWith(SYNC_DOWNLOAD_TEMP_SUFFIX)
}

/**
 * Creates a basename for a partial download owned by the given sync run.
 * @param ownerToken - Per-sync random owner token.
 * @param uniqueToken - Per-file random token.
 *
 * @returns A same-directory temp basename.
 */
export function syncDownloadTempName(ownerToken: string, uniqueToken: string): string {
  return `${SYNC_DOWNLOAD_TEMP_PREFIX}${ownerToken}-${uniqueToken}${SYNC_DOWNLOAD_TEMP_SUFFIX}`
}

/**
 * Checks whether a partial download belongs to the supplied sync run.
 * @param name - Directory entry basename.
 * @param ownerToken - Per-sync owner token.
 *
 * @returns True when the temp name carries the supplied owner token.
 */
export function isOwnedSyncDownloadTempName(name: string, ownerToken: string): boolean {
  return (
    isSyncDownloadTempName(name) && name.startsWith(`${SYNC_DOWNLOAD_TEMP_PREFIX}${ownerToken}-`)
  )
}

/**
 * Removes SDK-managed partial download files owned by the current sync run from a directory.
 * @param directory - Directory to sweep.
 * @param ownerToken - Per-sync owner token whose temp files may be removed.
 * @param options - Optional stale-file cleanup and diagnostic hooks.
 */
export async function removeSyncDownloadTempFiles(
  directory: string,
  ownerToken: string,
  options: SyncDownloadTempFileSweepOptions = {},
): Promise<void> {
  const { readdir, rm, stat } = await import('node:fs/promises')

  let entries: DirectoryEntry[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  const { join } = await import('node:path')
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSyncDownloadTempName(entry.name))
      .map(async (entry) => {
        const path = join(directory, entry.name)
        if (isOwnedSyncDownloadTempName(entry.name, ownerToken)) {
          await rm(path, { force: true })
          return
        }

        await removeStaleSyncDownloadTempFile(directory, entry.name, path, stat, rm, options)
      }),
  )
}

/**
 * Creates a per-sync sweep cache for SDK-managed partial download files owned by this run.
 * @param ownerToken - Per-sync owner token. Defaults to a fresh random token.
 * @param options - Optional stale-file cleanup and diagnostic hooks.
 *
 * @returns A function that shares one sweep promise per directory.
 */
export function createSyncDownloadTempFileSweeper(
  ownerToken = randomSyncDownloadTempOwnerToken(),
  options: SyncDownloadTempFileSweepOptions = {},
): SyncDownloadTempFileSweeper {
  const sweptSyncDownloadTempDirectories = new Map<string, Promise<void>>()

  function removeSyncDownloadTempFilesOnce(directory: string): Promise<void> {
    const existing = sweptSyncDownloadTempDirectories.get(directory)
    if (existing !== undefined) return existing

    const sweep = removeSyncDownloadTempFiles(directory, ownerToken, options).catch(
      (error: unknown) => {
        sweptSyncDownloadTempDirectories.delete(directory)
        throw error
      },
    )
    sweptSyncDownloadTempDirectories.set(directory, sweep)
    return sweep
  }

  return Object.assign(removeSyncDownloadTempFilesOnce, { ownerToken })
}

async function removeStaleSyncDownloadTempFile(
  directory: string,
  name: string,
  path: string,
  stat: (path: string) => Promise<FileStats>,
  rm: (path: string, options: { readonly force: true }) => Promise<void>,
  options: SyncDownloadTempFileSweepOptions,
): Promise<void> {
  const staleMillis = options.staleMillis ?? DEFAULT_STALE_SYNC_DOWNLOAD_TEMP_MILLIS
  const nowMillis = options.nowMillis?.() ?? Date.now()
  let stats: FileStats
  try {
    stats = await stat(path)
  } catch {
    return
  }

  const ageMillis = nowMillis - stats.mtimeMs
  if (ageMillis < staleMillis) return

  try {
    await rm(path, { force: true })
    emitSweepEvent(options, {
      action: 'removed-stale',
      directory,
      name,
      ageMillis,
      message: `Removed stale SDK partial download file ${JSON.stringify(name)}`,
    })
  } catch {
    emitSweepEvent(options, {
      action: 'retained-stale',
      directory,
      name,
      ageMillis,
      message: `Retained stale SDK partial download file ${JSON.stringify(name)}: removal failed`,
    })
  }
}

function emitSweepEvent(
  options: SyncDownloadTempFileSweepOptions,
  event: SyncDownloadTempFileSweepEvent,
): void {
  try {
    options.onEvent?.(event)
  } catch {
    // Diagnostics hooks must not change cleanup behavior.
  }
}

function randomSyncDownloadTempOwnerToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}
