export const SYNC_DOWNLOAD_TEMP_PREFIX = '.b2sdk-'
export const SYNC_DOWNLOAD_TEMP_SUFFIX = '.partial'

export interface SyncDownloadTempFileSweeper {
  readonly ownerToken: string
  (directory: string): Promise<void>
}

type DirectoryEntry = {
  name: string
  isFile(): boolean
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
 */
export async function removeSyncDownloadTempFiles(
  directory: string,
  ownerToken: string,
): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises')

  let entries: DirectoryEntry[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  const { join } = await import('node:path')
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isOwnedSyncDownloadTempName(entry.name, ownerToken))
      .map((entry) => rm(join(directory, entry.name), { force: true })),
  )
}

/**
 * Creates a per-sync sweep cache for SDK-managed partial download files owned by this run.
 * @param ownerToken - Per-sync owner token. Defaults to a fresh random token.
 *
 * @returns A function that shares one sweep promise per directory.
 */
export function createSyncDownloadTempFileSweeper(
  ownerToken = randomSyncDownloadTempOwnerToken(),
): SyncDownloadTempFileSweeper {
  const sweptSyncDownloadTempDirectories = new Map<string, Promise<void>>()

  function removeSyncDownloadTempFilesOnce(directory: string): Promise<void> {
    const existing = sweptSyncDownloadTempDirectories.get(directory)
    if (existing !== undefined) return existing

    const sweep = removeSyncDownloadTempFiles(directory, ownerToken).catch((error: unknown) => {
      sweptSyncDownloadTempDirectories.delete(directory)
      throw error
    })
    sweptSyncDownloadTempDirectories.set(directory, sweep)
    return sweep
  }

  return Object.assign(removeSyncDownloadTempFilesOnce, { ownerToken })
}

function randomSyncDownloadTempOwnerToken(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}
