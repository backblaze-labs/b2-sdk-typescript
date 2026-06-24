import { safeRelativePathSegments } from './path-safety.ts'

export { assertSyncPathAllowed } from './path-safety.ts'

interface PathOperations {
  isAbsolute(path: string): boolean
  resolve(...paths: string[]): string
  readonly sep: string
}

/**
 * Resolves a sync-relative path under a local root without allowing traversal
 * or SDK-reserved temporary-file names.
 * @param root - Absolute local sync root.
 * @param relativePath - Sync-relative path to resolve.
 * @param path - Node path operations for the local platform.
 *
 * @returns The absolute local filesystem path.
 *
 * @throws If the path is absolute, escapes the root, or uses a reserved basename.
 */
export function resolveSafeLocalPath(
  root: string,
  relativePath: string,
  path: PathOperations,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Sync path must be relative: ${relativePath}`)
  }
  const segments = safeRelativePathSegments(relativePath)
  const fullPath = path.resolve(root, ...segments)
  const rootPath = path.resolve(root)
  const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
  if (fullPath !== rootPath && !fullPath.startsWith(rootPrefix)) {
    throw new Error(`Sync path escapes the local root: ${relativePath}`)
  }
  return fullPath
}
