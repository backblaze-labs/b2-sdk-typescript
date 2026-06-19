export function normalizeB2FolderPrefix(prefix: string): string {
  const normalized = prefix.split('\\').join('/')
  if (normalized === '' || normalized.endsWith('/')) return normalized
  return `${normalized}/`
}

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
