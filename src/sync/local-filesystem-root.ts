import type { SyncFolder } from './types.ts'

const localFilesystemRoots = new WeakSet<SyncFolder>()

/**
 * Privately marks SDK local folders that are backed by the filesystem.
 * @param folder - Local folder instance to mark.
 *
 * @internal
 */
export function registerLocalFilesystemRoot(folder: SyncFolder): void {
  localFilesystemRoots.add(folder)
}

/**
 * Returns true for SDK local folders backed by the filesystem.
 * @param folder - Sync folder to inspect.
 *
 * @returns True when the folder was registered as an SDK filesystem root.
 *
 * @internal
 */
export function isLocalFilesystemRoot(folder: SyncFolder): boolean {
  return localFilesystemRoots.has(folder)
}
