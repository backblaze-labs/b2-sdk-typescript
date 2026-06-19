import type { SyncFilterOptions, SyncFilterPattern, SyncPath } from './types.ts'

const globCache = new Map<string, RegExp>()

/**
 * Tests whether a relative sync path is included by the configured include/exclude filters.
 * Exclude filters win over include filters when both match the same path.
 *
 * @param relativePath - Folder-relative path using forward slashes.
 * @param filters - Optional include and exclude filters.
 *
 * @returns True when the path should remain in the sync scan.
 */
export function pathPassesSyncFilters(
  relativePath: string,
  filters: SyncFilterOptions | undefined,
): boolean {
  const path = normalizePath(relativePath)
  const include = filters?.include ?? []
  const exclude = filters?.exclude ?? []

  if (include.length > 0 && !include.some((pattern) => matchesPattern(path, pattern))) {
    return false
  }

  return !exclude.some((pattern) => matchesPattern(path, pattern))
}

/**
 * Filters an async iterable of sync paths while preserving the original item type.
 *
 * @typeParam T - Concrete sync path shape yielded by the source folder.
 *
 * @param paths - Async iterable of folder scan results.
 * @param filters - Optional include and exclude filters.
 *
 * @returns A filtered async generator of sync paths.
 */
export async function* filterSyncPaths<T extends SyncPath>(
  paths: AsyncIterable<T>,
  filters: SyncFilterOptions | undefined,
): AsyncGenerator<T> {
  for await (const path of paths) {
    if (pathPassesSyncFilters(path.relativePath, filters)) {
      yield path
    }
  }
}

function matchesPattern(relativePath: string, pattern: SyncFilterPattern): boolean {
  if (typeof pattern !== 'string') {
    pattern.lastIndex = 0
    const matched = pattern.test(relativePath)
    pattern.lastIndex = 0
    return matched
  }

  const glob = normalizePath(pattern)
  const regex = regexForGlob(glob)
  if (regex.test(relativePath)) return true

  if (!glob.includes('/')) {
    const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    return regex.test(basename)
  }

  return false
}

function regexForGlob(glob: string): RegExp {
  const cached = globCache.get(glob)
  if (cached) return cached

  const regex = new RegExp(`^${globToRegexSource(glob)}$`)
  globCache.set(glob, regex)
  return regex
}

function globToRegexSource(glob: string): string {
  let source = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      let starEnd = i + 1
      while (glob[starEnd] === '*') starEnd++

      if (starEnd - i > 1) {
        if (glob[starEnd] === '/') {
          source += '(?:.*/)?'
          i = starEnd
        } else {
          source += '.*'
          i = starEnd - 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegexChar(char)
    }
  }

  return source
}

function escapeRegexChar(char: string | undefined): string {
  if (char === undefined) return ''
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char
}

function normalizePath(path: string): string {
  let normalized = path.split('\\').join('/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.startsWith('/')) normalized = normalized.slice(1)
  return normalized
}
