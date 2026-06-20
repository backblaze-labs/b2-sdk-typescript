export const SYNC_DOWNLOAD_TEMP_PREFIX = '.b2sdk-'
export const SYNC_DOWNLOAD_TEMP_SUFFIX = '.partial'

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
 * Removes stale SDK-managed partial download files from a directory.
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
      .filter((entry) => isSyncDownloadTempName(entry.name))
      .map((entry) => rm(join(directory, entry.name), { force: true })),
  )
}
