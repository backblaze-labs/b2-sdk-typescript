/**
 * Validates B2 relative names before they are materialized on a local filesystem.
 *
 * @param relPath - B2-style relative path.
 *
 * @returns Validated path segments.
 *
 * @throws When the path is empty, absolute, platform-ambiguous, or contains traversal.
 *
 * @internal
 */
export function safeRelativePathSegments(relPath: string): string[] {
  if (
    relPath.length === 0 ||
    relPath.includes('\0') ||
    relPath.includes('\\') ||
    relPath.startsWith('/') ||
    /^[A-Za-z]:/.test(relPath)
  ) {
    throw new Error('unsafe local destination path')
  }

  const segments = relPath.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('unsafe local destination path')
  }
  return segments
}

/**
 * Throws if {@link target} is not contained by {@link root}.
 *
 * @param root - Resolved filesystem root.
 * @param target - Candidate path to validate.
 * @param path - Node path module.
 *
 * @throws When the target is not inside the root.
 *
 * @internal
 */
export function assertPathInsideRoot(
  root: string,
  target: string,
  path: typeof import('node:path'),
): void {
  const relative = path.relative(root, target)
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('unsafe local destination path')
  }
}

/**
 * Returns the platform's no-follow open flag when available.
 *
 * @param constants - Node filesystem constants.
 *
 * @returns The `O_NOFOLLOW` bit or `0`.
 *
 * @internal
 */
export function noFollowFlag(constants: { readonly O_NOFOLLOW?: number }): number {
  return constants.O_NOFOLLOW ?? 0
}

/**
 * Checks whether an unknown thrown value has a specific Node error code.
 *
 * @param err - Unknown thrown value.
 * @param code - Expected Node error code.
 *
 * @returns True when the value exposes the expected code.
 *
 * @internal
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  return (err as { readonly code?: unknown }).code === code
}
