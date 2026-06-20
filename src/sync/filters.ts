import {
  pathExceedsSafeRegExpInput,
  regexpMatchesSyncPath,
  validateSyncFilters,
} from './regexp-safety.ts'
import { emitScannerSkip, regexpInputTooLongSkip } from './scan-events.ts'
import type { SyncFilterOptions, SyncFilterPattern, SyncPath } from './types.ts'

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
  validateSyncFilters(filters)
  const path = normalizePath(relativePath)
  if (normalizedPathSkippedByRegExpInputLimit(path, filters)) return false

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
  validateSyncFilters(filters)
  const path = normalizePath(relativePath)
  if (path === '') return true

  const exclude = filters?.exclude ?? []
  if (exclude.some((pattern) => stringPatternExcludesAllDescendants(path, pattern))) {
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
  validateSyncFilters(filters)
  const include = filters?.include ?? []
  let commonPrefix: string | undefined

  for (const pattern of include) {
    if (patternIsRegExp(pattern)) return ''

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
    } else if (pathSkippedByRegExpInputLimit(path.relativePath, filters)) {
      emitScannerSkip(filters, regexpInputTooLongSkip(normalizePath(path.relativePath)))
    }
  }
}

/**
 * Tests whether a path is skipped solely because RegExp filters are configured and the normalized
 * path exceeds the SDK RegExp input guard.
 *
 * @param relativePath - Folder-relative path using forward slashes.
 * @param filters - Optional include and exclude filters.
 *
 * @returns True when RegExp filters are present and the path is too long to evaluate.
 */
export function pathSkippedByRegExpInputLimit(
  relativePath: string,
  filters: SyncFilterOptions | undefined,
): boolean {
  validateSyncFilters(filters)
  return normalizedPathSkippedByRegExpInputLimit(normalizePath(relativePath), filters)
}

function normalizedPathSkippedByRegExpInputLimit(
  normalizedPath: string,
  filters: SyncFilterOptions | undefined,
): boolean {
  return pathExceedsSafeRegExpInput(normalizedPath) && filtersContainRegExp(filters)
}

function matchesPattern(relativePath: string, pattern: SyncFilterPattern): boolean {
  if (patternIsRegExp(pattern)) {
    return regexpMatchesSyncPath(relativePath, pattern)
  }

  const glob = normalizePath(pattern)
  if (glob === '') return relativePath === ''

  const segments = splitPath(relativePath)
  if (!glob.includes('/')) {
    return segments.some((segment) => matchSegmentGlob(segment, glob))
  }

  return matchPathGlob(segments, splitPath(glob))
}

function stringPatternExcludesAllDescendants(
  relativePath: string,
  pattern: SyncFilterPattern,
): boolean {
  if (patternIsRegExp(pattern)) return false

  const glob = normalizePath(pattern)
  if (glob === '') return false
  if (!glob.includes('/')) return matchesPattern(relativePath, pattern)

  const globSegments = splitPath(glob)
  return globSegments.at(-1) === '**' && matchPathGlob(splitPath(relativePath), globSegments)
}

function filtersContainRegExp(filters: SyncFilterOptions | undefined): boolean {
  return (
    filters?.include?.some(patternIsRegExp) === true ||
    filters?.exclude?.some(patternIsRegExp) === true
  )
}

function patternMayMatchDescendant(relativePath: string, pattern: SyncFilterPattern): boolean {
  if (patternIsRegExp(pattern)) return true

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

function literalPrefixForGlob(glob: string): string {
  const segments = splitPath(glob)
  const literalSegments: string[] = []
  let firstWildcardIndex = segments.length

  for (const [index, segment] of segments.entries()) {
    if (segment === '**' || hasGlobWildcard(segment)) {
      firstWildcardIndex = index
      break
    }
    literalSegments.push(segment)
  }

  if (literalSegments.length === 0) return ''
  const prefix = literalSegments.join('/')
  const wildcardTail = segments.slice(firstWildcardIndex)
  const tailMayMatchBarePrefix =
    wildcardTail.length > 0 && wildcardTail.every((segment) => segment === '**')
  if (tailMayMatchBarePrefix) return prefix
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

function patternIsRegExp(pattern: SyncFilterPattern): pattern is RegExp {
  return typeof pattern !== 'string'
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
