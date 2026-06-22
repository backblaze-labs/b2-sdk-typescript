const RESERVED_SYNC_TEMP_FILE_RE = /^\.b2sdk-[0-9a-f]{24}-[^/\\]+-[0-9a-f]{32}\.partial$/i

interface PathOperations {
  isAbsolute(path: string): boolean
  resolve(...paths: string[]): string
  readonly sep: string
}

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
  assertSyncPathAllowed(relativePath)
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Sync path must be relative: ${relativePath}`)
  }
  const fullPath = path.resolve(root, relativePath)
  const rootPath = path.resolve(root)
  const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
  if (fullPath !== rootPath && !fullPath.startsWith(rootPrefix)) {
    throw new Error(`Sync path escapes the local root: ${relativePath}`)
  }
  return fullPath
}

/**
 * Resolves and prepares a local download target under a sync root, rejecting
 * symlinked parent directories before the caller opens the file for writing.
 * @param root - Absolute local sync root.
 * @param relativePath - Sync-relative path to write.
 *
 * @returns The absolute local filesystem path.
 *
 * @throws If the target escapes the root, uses a reserved basename, or has a
 *   symlinked parent component.
 */
export async function resolveSafeLocalWritePath(
  root: string,
  relativePath: string,
): Promise<string> {
  if (root === '') {
    throw new Error('Sync local root is required for downloads.')
  }

  const path = await import('node:path')
  const { lstat, mkdir, realpath } = await import('node:fs/promises')
  const fullPath = resolveSafeLocalPath(root, relativePath, path)
  const parentPath = path.dirname(fullPath)
  const rootPath = path.resolve(root)
  await mkdir(rootPath, { recursive: true })
  const rootStats = await lstat(rootPath)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Sync local root is not a real directory: ${root}`)
  }

  const parentFromRoot = path.relative(rootPath, parentPath)
  let current = rootPath
  if (parentFromRoot !== '') {
    for (const segment of parentFromRoot.split(path.sep).filter(Boolean)) {
      current = path.resolve(current, segment)
      let stats: Awaited<ReturnType<typeof lstat>>
      try {
        stats = await lstat(current)
      } catch (err) {
        if (!isNodeErrorCode(err, 'ENOENT')) throw err
        try {
          await mkdir(current)
        } catch (mkdirErr) {
          if (!isNodeErrorCode(mkdirErr, 'EEXIST')) throw mkdirErr
        }
        stats = await lstat(current)
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Sync path has an unsafe parent directory: ${relativePath}`)
      }
    }
  }

  const rootRealPath = await realpath(rootPath)
  const parentRealPath = await realpath(parentPath)
  const relativeParent = path.relative(rootRealPath, parentRealPath)
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw new Error(`Sync path escapes the local root: ${relativePath}`)
  }

  try {
    const targetStats = await lstat(fullPath)
    if (targetStats.isSymbolicLink()) {
      throw new Error(`Sync path has an unsafe target: ${relativePath}`)
    }
    if (targetStats.isFile() && targetStats.nlink > 1) {
      throw new Error(`Sync path has an unsafe hardlinked target: ${relativePath}`)
    }
  } catch (err) {
    if (!isNodeErrorCode(err, 'ENOENT')) throw err
  }

  return fullPath
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  )
}
