export function normalizeB2FolderPrefix(prefix: string): string {
  if (prefix === '' || prefix.endsWith('/')) return prefix
  return `${prefix}/`
}

export function normalizeB2RelativePath(path: string): string {
  const relativePath = stripLeadingSlashes(path.split('\\').join('/'))
  if (/^[A-Za-z]:/.test(relativePath) || relativePath.split('/').includes('..')) {
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
