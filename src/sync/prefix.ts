export function normalizeB2FolderPrefix(prefix: string): string {
  if (prefix === '' || prefix.endsWith('/')) return prefix
  return `${prefix}/`
}

export function stripLeadingSlashes(path: string): string {
  let relativePath = path
  while (relativePath.startsWith('/')) {
    relativePath = relativePath.slice(1)
  }
  return relativePath
}
