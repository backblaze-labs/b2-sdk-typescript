import type { SyncFilterOptions, SyncFilterPattern } from './types.ts'

const MAX_REGEXP_SOURCE_LENGTH = 512
const MAX_REGEXP_INPUT_LENGTH = 1024
const MAX_REGEXP_UNBOUNDED_QUANTIFIERS = 1
const safeRegExpCache = new WeakMap<RegExp, RegExp>()

/**
 * Validates every RegExp filter in an include/exclude filter set.
 *
 * @param filters - Optional include and exclude filters to validate.
 *
 * @throws When a RegExp filter is too large or structurally unsafe.
 */
export function validateSyncFilters(filters: SyncFilterOptions | undefined): void {
  validateSyncFilterList('include', filters?.include)
  validateSyncFilterList('exclude', filters?.exclude)
}

/**
 * Tests a path with a caller-provided RegExp without retaining `lastIndex` state.
 *
 * @param relativePath - Folder-relative path to test.
 * @param pattern - Caller-provided RegExp filter.
 *
 * @returns True when the RegExp matches the relative path.
 *
 * @throws When the RegExp filter is too large or structurally unsafe.
 */
export function regexpMatchesSyncPath(relativePath: string, pattern: RegExp): boolean {
  if (pathExceedsSafeRegExpInput(relativePath)) return false
  return regexpWithoutState(pattern).test(relativePath)
}

/**
 * Tests whether a relative path is too long to feed to caller-provided RegExp filters.
 *
 * @param relativePath - Folder-relative path to test.
 *
 * @returns True when RegExp filters should not be evaluated for the path.
 */
export function pathExceedsSafeRegExpInput(relativePath: string): boolean {
  return relativePath.length > MAX_REGEXP_INPUT_LENGTH
}

function validateSyncFilterList(
  kind: 'include' | 'exclude',
  patterns: readonly SyncFilterPattern[] | undefined,
): void {
  for (const pattern of patterns ?? []) {
    if (typeof pattern !== 'string') {
      regexpWithoutState(pattern, kind)
    }
  }
}

function regexpWithoutState(pattern: RegExp, kind = 'pattern'): RegExp {
  const cached = safeRegExpCache.get(pattern)
  if (cached !== undefined) return cached

  assertSafeRegExp(pattern, kind)
  const compiled = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  safeRegExpCache.set(pattern, compiled)
  return compiled
}

function assertSafeRegExp(pattern: RegExp, kind: string): void {
  const source = pattern.source
  if (source.length > MAX_REGEXP_SOURCE_LENGTH) {
    throw new Error(`Sync filter RegExp is too long (${kind}: /${source}/)`)
  }

  if (!regexpSourceLooksSafe(source)) {
    throw new Error(`Sync filter RegExp is too complex (${kind}: /${source}/)`)
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
