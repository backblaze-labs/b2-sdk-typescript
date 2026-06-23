/**
 * Treats the supplied string as a raw B2 key prefix without adding a folder boundary.
 *
 * B2 keys are byte-oriented names, not local filesystem paths. A backslash in a prefix is a real
 * key character and must not be rewritten to `/`; callers that want slash-delimited prefixes should
 * pass `/` explicitly.
 *
 * @param prefix - User-supplied raw B2 key prefix.
 *
 * @returns Raw B2 key prefix.
 */
export function asRawB2KeyPrefix(prefix: string): string {
  return prefix
}

/**
 * Normalizes a B2 object name into a safe folder-relative sync path.
 *
 * Object names are converted to forward-slash sync paths for local compatibility. Callers that scan
 * B2 must detect normalized-path collisions between distinct raw B2 keys before yielding entries.
 *
 * @param path - B2 object name or prefix-stripped suffix returned by a listing.
 * @param options - Optional normalization behavior for legacy slashless raw prefixes.
 *
 * @returns Folder-relative sync path.
 *
 * @throws When the object name cannot be represented as a safe relative path.
 */
export function normalizeB2RelativePath(
  path: string,
  options: { readonly stripLeadingSlashes?: boolean } = {},
): string {
  const slashPath = path.split('\\').join('/')
  const relativePath =
    options.stripLeadingSlashes === true ? stripSingleLeadingSlash(slashPath) : slashPath
  const segments = relativePath.split('/')
  if (/^[A-Za-z]:/.test(relativePath) || segments.some((segment) => segmentIsUnsafe(segment))) {
    throw new Error('Unsafe B2 file name cannot be used as a sync relative path')
  }
  return relativePath
}

/**
 * Converts a B2 object key under a configured raw prefix into a sync relative path.
 *
 * @param prefix - Raw B2 key prefix used for the scan or mutation guard.
 * @param fileName - Full B2 object key.
 *
 * @returns The normalized sync relative path for the key suffix.
 */
export function b2KeyToRelativePathUnderPrefix(prefix: string, fileName: string): string {
  const rawPrefix = asRawB2KeyPrefix(prefix)
  const suffix = rawPrefix === '' ? fileName : fileName.slice(rawPrefix.length)
  return normalizeB2RelativePath(suffix, {
    stripLeadingSlashes: rawPrefix !== '' && !rawPrefix.endsWith('/'),
  })
}

/**
 * Returns whether a sync path is unsafe to materialize on Windows-compatible local filesystems.
 * B2-to-B2 syncs can preserve these object names, but B2-to-local syncs skip them before writing.
 *
 * @param relativePath - Folder-relative sync path.
 *
 * @returns True when any segment is Windows-dangerous or ambiguous.
 */
export function localFilesystemSyncPathIsUnsafe(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segmentIsLocalFilesystemUnsafe(segment))
}

/**
 * Produces an approximate Windows/macOS-style canonical key for local collision detection.
 *
 * @param relativePath - Folder-relative sync path.
 *
 * @returns A canonicalized path key for detecting case/Unicode collisions before local writes.
 */
export function localFilesystemCanonicalSyncPath(relativePath: string): string {
  return relativePath
    .split('/')
    .map((segment) => segment.normalize('NFC').toLocaleLowerCase('en-US'))
    .join('/')
}

function segmentIsUnsafe(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || containsControlCharacter(segment)
}

function segmentIsLocalFilesystemUnsafe(segment: string): boolean {
  if (segment.includes(':') || segment.endsWith('.') || segment.endsWith(' ')) return true
  const basename = segment.split('.')[0]?.toUpperCase()
  return (
    basename !== undefined &&
    /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9]|LPT[0-9])$/.test(basename)
  )
}

function containsControlCharacter(segment: string): boolean {
  for (let index = 0; index < segment.length; index++) {
    const code = segment.charCodeAt(index)
    if (code >= 0 && code <= 31) return true
  }
  return false
}

function stripSingleLeadingSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path
}
