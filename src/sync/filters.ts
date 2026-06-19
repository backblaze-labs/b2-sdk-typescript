import type { SyncFilterOptions, SyncFilterPattern, SyncPath } from './types.ts'

const MAX_REGEXP_SOURCE_LENGTH = 512
const MAX_REGEXP_UNBOUNDED_QUANTIFIERS = 8
const safeRegExpCache = new WeakMap<RegExp, RegExp>()

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
 * Tests whether a directory may contain paths admitted by the configured filters.
 *
 * @param relativePath - Folder-relative directory path using forward slashes.
 * @param filters - Optional include and exclude filters.
 *
 * @returns True when the scanner should descend into the directory.
 */
export function directoryMayContainSyncPaths(
  relativePath: string,
  filters: SyncFilterOptions | undefined,
): boolean {
  const path = normalizePath(relativePath)
  if (path === '') return true

  const exclude = filters?.exclude ?? []
  if (exclude.some((pattern) => stringPatternMatches(path, pattern))) {
    return false
  }

  const include = filters?.include ?? []
  return include.length === 0 || include.some((pattern) => patternMayMatchDescendant(path, pattern))
}

/**
 * Returns the safe literal prefix that B2 listing can use for include filters.
 * Exclude filters are not considered because they cannot narrow a B2 prefix.
 *
 * @param filters - Optional include and exclude filters.
 *
 * @returns A folder-relative literal prefix, or an empty string when no safe narrowing exists.
 */
export function literalPrefixForSyncFilters(filters: SyncFilterOptions | undefined): string {
  const include = filters?.include ?? []
  let commonPrefix: string | undefined

  for (const pattern of include) {
    if (typeof pattern !== 'string') return ''

    const glob = normalizePath(pattern)
    if (!glob.includes('/')) return ''

    const prefix = literalPrefixForGlob(glob)
    if (prefix === '') return ''
    commonPrefix = commonPrefix === undefined ? prefix : commonLiteralPrefix(commonPrefix, prefix)
  }

  return commonPrefix ?? ''
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
    return regexpWithoutState(pattern).test(relativePath)
  }

  const glob = normalizePath(pattern)
  if (glob === '') return relativePath === ''

  const segments = splitPath(relativePath)
  if (!glob.includes('/')) {
    return segments.some((segment) => matchSegmentGlob(segment, glob))
  }

  return matchPathGlob(segments, splitPath(glob))
}

function stringPatternMatches(relativePath: string, pattern: SyncFilterPattern): boolean {
  return typeof pattern === 'string' && matchesPattern(relativePath, pattern)
}

function patternMayMatchDescendant(relativePath: string, pattern: SyncFilterPattern): boolean {
  if (typeof pattern !== 'string') return true

  const glob = normalizePath(pattern)
  if (glob === '' || !glob.includes('/')) return true

  const pathSegments = splitPath(relativePath)
  const globSegments = splitPath(glob)
  const length = Math.min(pathSegments.length, globSegments.length)

  for (let i = 0; i < length; i++) {
    const globSegment = globSegments[i]
    if (globSegment === '**' || globSegment === undefined || hasGlobWildcard(globSegment)) {
      return true
    }
    if (globSegment !== pathSegments[i]) {
      return false
    }
  }

  return true
}

function matchPathGlob(pathSegments: readonly string[], globSegments: readonly string[]): boolean {
  let reachable = new Array<boolean>(pathSegments.length + 1).fill(false)
  reachable[0] = true

  for (const globSegment of globSegments) {
    const next = new Array<boolean>(pathSegments.length + 1).fill(false)

    if (globSegment === '**') {
      // A whole-segment `**` consumes zero or more complete path segments.
      let canReach = false
      for (let i = 0; i <= pathSegments.length; i++) {
        canReach = canReach || reachable[i] === true
        next[i] = canReach
      }
    } else {
      for (let i = 0; i < pathSegments.length; i++) {
        if (reachable[i] === true && matchSegmentGlob(pathSegments[i] ?? '', globSegment)) {
          next[i + 1] = true
        }
      }
    }

    reachable = next
  }

  return reachable[pathSegments.length] === true
}

function matchSegmentGlob(segment: string, glob: string): boolean {
  let segmentIndex = 0
  let globIndex = 0
  let starIndex = -1
  let starMatchIndex = 0

  while (segmentIndex < segment.length) {
    const globChar = glob[globIndex]
    if (globChar === '?' || globChar === segment[segmentIndex]) {
      globIndex++
      segmentIndex++
    } else if (globChar === '*') {
      // Repeated `*` in one segment is still one segment-local wildcard.
      while (glob[globIndex + 1] === '*') globIndex++
      starIndex = globIndex
      starMatchIndex = segmentIndex
      globIndex++
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1
      starMatchIndex++
      segmentIndex = starMatchIndex
    } else {
      return false
    }
  }

  while (glob[globIndex] === '*') globIndex++
  return globIndex === glob.length
}

function regexpWithoutState(pattern: RegExp): RegExp {
  const cached = safeRegExpCache.get(pattern)
  if (cached !== undefined) return cached

  assertSafeRegExp(pattern)
  const compiled = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  safeRegExpCache.set(pattern, compiled)
  return compiled
}

function assertSafeRegExp(pattern: RegExp): void {
  const source = pattern.source
  if (source.length > MAX_REGEXP_SOURCE_LENGTH) {
    throw new Error('Sync filter RegExp is too long')
  }

  if (!regexpSourceLooksSafe(source)) {
    throw new Error('Sync filter RegExp is too complex')
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keep the regex safety scan linear.
function regexpSourceLooksSafe(source: string): boolean {
  let escaped = false
  let inClass = false
  let unboundedQuantifiers = 0
  const groups: Array<{ hasQuantifier: boolean; hasAlternation: boolean }> = []
  let lastToken:
    | { type: 'atom' }
    | { type: 'group'; hasQuantifier: boolean; hasAlternation: boolean }
    | null = null

  for (let i = 0; i < source.length; i++) {
    const char = source[i] ?? ''

    if (escaped) {
      if (!inClass && char === 'k' && source[i + 1] === '<') return false
      if (!inClass && /[1-9]/.test(char)) return false
      escaped = false
      lastToken = { type: 'atom' }
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inClass) {
      if (char === ']') inClass = false
      continue
    }

    if (char === '[') {
      inClass = true
      lastToken = { type: 'atom' }
      continue
    }

    if (char === '(') {
      groups.push({ hasQuantifier: false, hasAlternation: false })
      lastToken = null
      continue
    }

    if (char === ')') {
      const group = groups.pop()
      if (!group) return false
      lastToken = { type: 'group', ...group }
      continue
    }

    if (char === '|') {
      const group = groups.at(-1)
      if (group) group.hasAlternation = true
      lastToken = null
      continue
    }

    if (lastToken !== null && isQuantifierStart(source, i)) {
      if (lastToken?.type === 'group' && (lastToken.hasQuantifier || lastToken.hasAlternation)) {
        return false
      }

      if (isUnboundedQuantifier(source, i)) {
        unboundedQuantifiers++
        if (unboundedQuantifiers > MAX_REGEXP_UNBOUNDED_QUANTIFIERS) return false
      }

      const group = groups.at(-1)
      if (group) group.hasQuantifier = true

      if (char === '{') {
        const end = source.indexOf('}', i + 1)
        if (end === -1) return false
        i = end
      }

      lastToken = null
      continue
    }

    lastToken = { type: 'atom' }
  }

  return !escaped && !inClass && groups.length === 0
}

function isQuantifierStart(source: string, index: number): boolean {
  const char = source[index]
  if (char === '*' || char === '+' || char === '?') return true
  if (char !== '{') return false

  const end = source.indexOf('}', index + 1)
  return end !== -1 && /^\d+(?:,\d*)?$/.test(source.slice(index + 1, end))
}

function isUnboundedQuantifier(source: string, index: number): boolean {
  const char = source[index]
  if (char === '*' || char === '+') return true
  if (char !== '{') return false

  const end = source.indexOf('}', index + 1)
  return end !== -1 && source.slice(index + 1, end).endsWith(',')
}

function literalPrefixForGlob(glob: string): string {
  const segments = splitPath(glob)
  const literalSegments: string[] = []

  for (const segment of segments) {
    if (segment === '**' || hasGlobWildcard(segment)) break
    literalSegments.push(segment)
  }

  if (literalSegments.length === 0) return ''
  const prefix = literalSegments.join('/')
  return literalSegments.length < segments.length ? `${prefix}/` : prefix
}

function commonLiteralPrefix(a: string, b: string): string {
  let end = 0
  const max = Math.min(a.length, b.length)
  while (end < max && a[end] === b[end]) end++
  return trimTrailingHighSurrogate(a.slice(0, end))
}

function trimTrailingHighSurrogate(value: string): string {
  const lastCodeUnit = value.charCodeAt(value.length - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? value.slice(0, -1) : value
}

function hasGlobWildcard(glob: string): boolean {
  return glob.includes('*') || glob.includes('?')
}

function splitPath(path: string): string[] {
  if (path === '') return []
  return path.split('/').filter((segment) => segment !== '')
}

function normalizePath(path: string): string {
  let normalized = path.split('\\').join('/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  while (normalized.startsWith('/')) normalized = normalized.slice(1)
  while (normalized.endsWith('/') && normalized.length > 1) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}
