export const SYNC_DOWNLOAD_TEMP_PREFIX = '.b2sdk-'
export const SYNC_DOWNLOAD_TEMP_SUFFIX = '.partial'

export type SyncDownloadTempFileSweeper = (directory: string) => Promise<void>

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
 * Removes SDK-managed partial download files from a directory.
 * @param directory - Directory to sweep.
 */
export async function removeSyncDownloadTempFiles(directory: string): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises')

  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  const { join } = await import('node:path')
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && isSyncDownloadTempName(entry.name))
      .map((entry) => rm(join(directory, entry.name), { force: true })),
  )
}

/**
 * Creates a per-sync sweep cache for SDK-managed partial download files.
 *
 * @returns A function that shares one sweep promise per directory.
 */
export function createSyncDownloadTempFileSweeper(): SyncDownloadTempFileSweeper {
  const sweptSyncDownloadTempDirectories = new Map<string, Promise<void>>()

  return function removeSyncDownloadTempFilesOnce(directory: string): Promise<void> {
    const existing = sweptSyncDownloadTempDirectories.get(directory)
    if (existing !== undefined) return existing

    const sweep = removeSyncDownloadTempFiles(directory).catch((error: unknown) => {
      sweptSyncDownloadTempDirectories.delete(directory)
      throw error
    })
    sweptSyncDownloadTempDirectories.set(directory, sweep)
    return sweep
  }
}
