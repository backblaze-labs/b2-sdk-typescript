/**
 * Normalizes a raw B2 key prefix to use forward slashes without adding a folder boundary.
 *
 * @param prefix - User-supplied raw B2 key prefix.
 *
 * @returns Normalized raw B2 key prefix.
 */
export function normalizeB2FolderPrefix(prefix: string): string {
  return prefix.split('\\').join('/')
}

/**
 * Normalizes a B2 object name into a safe folder-relative sync path.
 *
 * @param path - B2 object name returned by a listing.
 *
 * @returns Folder-relative sync path.
 *
 * @throws When the object name cannot be represented as a safe relative path.
 */
export function normalizeB2RelativePath(path: string): string {
  const relativePath = stripLeadingSlashes(path.split('\\').join('/'))
  const segments = relativePath.split('/')
  if (
    /^[A-Za-z]:/.test(relativePath) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Unsafe B2 file name cannot be used as a sync relative path')
  }
  return relativePath
}

function stripLeadingSlashes(path: string): string {
  let relativePath = path
  while (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1)
  }
  return relativePath
}
