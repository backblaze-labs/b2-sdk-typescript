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
    options.stripLeadingSlashes === true ? stripLeadingSlashes(slashPath) : slashPath
  const segments = relativePath.split('/')
  if (/^[A-Za-z]:/.test(relativePath) || segments.some((segment) => segmentIsUnsafe(segment))) {
    throw new Error('Unsafe B2 file name cannot be used as a sync relative path')
  }
  return relativePath
}

function segmentIsUnsafe(segment: string): boolean {
  return (
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes(':') ||
    containsControlCharacter(segment) ||
    /[ .]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)
  )
}

function containsControlCharacter(segment: string): boolean {
  for (let index = 0; index < segment.length; index++) {
    const code = segment.charCodeAt(index)
    if (code >= 0 && code <= 31) return true
  }
  return false
}

function stripLeadingSlashes(path: string): string {
  let relativePath = path
  while (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1)
  }
  return relativePath
}
