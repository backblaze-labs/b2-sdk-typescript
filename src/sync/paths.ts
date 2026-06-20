import { isAbsolute, resolve, sep } from 'node:path'

const RESERVED_SYNC_TEMP_FILE_RE = /^\.b2sdk-[0-9a-f]{24}-[^/\\]+-[0-9a-f]{32}\.partial$/i

/**
 * Rejects sync paths whose basename is reserved for SDK-owned temporary files.
 * @param relativePath - Sync-relative path using slash separators.
 *
 * @throws If any path segment uses the SDK's reserved temporary-file pattern.
 */
export function assertSyncPathAllowed(relativePath: string): void {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => RESERVED_SYNC_TEMP_FILE_RE.test(part))) {
    throw new Error(`Sync path uses reserved SDK temporary-file name: ${relativePath}`)
  }
}

/**
 * Resolves a sync-relative path under a local root without allowing traversal
 * or SDK-reserved temporary-file names.
 * @param root - Absolute local sync root.
 * @param relativePath - Sync-relative path to resolve.
 *
 * @returns The absolute local filesystem path.
 *
 * @throws If the path is absolute, escapes the root, or uses a reserved basename.
 */
export function resolveSafeLocalPath(root: string, relativePath: string): string {
  assertSyncPathAllowed(relativePath)
  if (isAbsolute(relativePath)) {
    throw new Error(`Sync path must be relative: ${relativePath}`)
  }
  const fullPath = resolve(root, relativePath)
  const rootPath = resolve(root)
  if (fullPath !== rootPath && !fullPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Sync path escapes the local root: ${relativePath}`)
  }
  return fullPath
}
