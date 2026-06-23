const RESERVED_SYNC_TEMP_FILE_RE = /^\.b2sdk-[0-9a-f]{24}-[^/\\]+-[0-9a-f]{32}\.partial$/i
const UUID_HEX_RE = /^[0-9a-f]{32}$/i

/**
 * Rejects sync paths whose basename is reserved for SDK-owned temporary files.
 * @param relativePath - Sync-relative path using slash separators.
 *
 * @throws If any path segment uses the SDK's reserved temporary-file pattern.
 *
 * @internal
 */
export function assertSyncPathAllowed(relativePath: string): void {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => RESERVED_SYNC_TEMP_FILE_RE.test(part))) {
    throw new Error(`Sync path uses reserved SDK temporary-file name: ${relativePath}`)
  }
}

/**
 * Creates a download staging basename inside the SDK-reserved temp namespace.
 * @param finalName - Final destination basename.
 * @param uuid - UUID used to make the temp basename unique.
 *
 * @returns A basename that local and B2 scanners reject as SDK-owned temp data.
 *
 * @throws If the provided UUID cannot be normalized to 32 hex characters.
 *
 * @internal
 */
export function makeReservedSyncTempFileName(finalName: string, uuid: string): string {
  if (finalName.length === 0 || /[\\/]/.test(finalName)) {
    throw new Error('invalid sync temporary-file basename')
  }
  const hex = uuid.replaceAll('-', '').toLowerCase()
  if (!UUID_HEX_RE.test(hex)) {
    throw new Error('invalid sync temporary-file nonce')
  }
  return `.b2sdk-${hex.slice(0, 24)}-${finalName}-${hex}.partial`
}

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
  assertSyncPathAllowed(relPath)
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
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        WINDOWS_RESERVED_NAME.test(segment),
    )
  ) {
    throw new Error('unsafe local destination path')
  }
  return segments
}

const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i

/**
 * Throws if {@link target} is outside {@link root} or names the root itself.
 *
 * @param root - Resolved filesystem root.
 * @param target - Candidate path to validate.
 * @param path - Node path module.
 *
 * @throws When the target is outside the root or equal to the root.
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
