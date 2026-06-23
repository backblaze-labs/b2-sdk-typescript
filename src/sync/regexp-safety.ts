import type { SyncFilterOptions, SyncFilterPattern } from './types.ts'

const MAX_REGEXP_SOURCE_LENGTH = 512
const MAX_REGEXP_INPUT_LENGTH = 1024
const MAX_REGEXP_UNBOUNDED_QUANTIFIERS = 1
const MAX_REGEXP_BOUNDED_QUANTIFIER = 200
const MAX_REGEXP_BOUNDED_QUANTIFIERS = 16
const MAX_REGEXP_BOUNDED_QUANTIFIER_PRODUCT = 10_000
const safeRegExpCache = new WeakMap<RegExp, RegExp>()
// Validation is memoized by object identity. Treat filter objects and their
// include/exclude arrays as immutable after first use, otherwise new patterns
// added later would not be revalidated through this cache.
const validatedFilterCache = new WeakSet<SyncFilterOptions>()

interface RegExpGroupState {
  hasQuantifier: boolean
  hasAlternation: boolean
}

type RegExpTokenState = { type: 'atom' } | ({ type: 'group' } & RegExpGroupState)

interface RegExpQuantifier {
  endIndex: number
  maxRepetitions: number
  unbounded: boolean
}

/**
 * Validates every RegExp filter in an include/exclude filter set.
 *
 * @param filters - Optional include and exclude filters to validate.
 *
 * @throws When a RegExp filter is too large or structurally unsafe.
 */
export function validateSyncFilters(filters: SyncFilterOptions | undefined): void {
  if (filters === undefined) return
  if (validatedFilterCache.has(filters)) return

  validateSyncFilterList('include', filters.include)
  validateSyncFilterList('exclude', filters.exclude)
  validatedFilterCache.add(filters)
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

/**
 * Best-effort linear RegExp guard for filters matched synchronously on attacker-controlled paths.
 *
 * The accepted subset intentionally rejects constructs that are hard to bound in the JavaScript
 * RegExp engine: backreferences, unterminated escapes/classes/groups, repeated unbounded
 * quantifiers, bounded quantifiers above {@link MAX_REGEXP_BOUNDED_QUANTIFIER}, too many bounded
 * quantifiers or too large a bounded-quantifier product, and any quantified group whose subtree
 * already contains a quantifier or alternation. Group state is propagated upward so nested groups
 * cannot hide a quantified or alternated subtree before an outer bounded or unbounded quantifier.
 *
 * @param source - RegExp source text to inspect.
 *
 * @returns True when the source passes the SDK's structural safety heuristic.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keep the regex safety scan linear.
function regexpSourceLooksSafe(source: string): boolean {
  let escaped = false
  let inClass = false
  let unboundedQuantifiers = 0
  let boundedQuantifiers = 0
  let boundedQuantifierProduct = 1
  const groups: RegExpGroupState[] = []
  let lastToken: RegExpTokenState | null = null

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
      const parent = groups.at(-1)
      if (parent) mergeGroupState(parent, group)
      lastToken = { type: 'group', ...group }
      continue
    }

    if (char === '|') {
      const group = groups.at(-1)
      if (group) group.hasAlternation = true
      lastToken = null
      continue
    }

    const quantifier = lastToken !== null ? parseQuantifier(source, i) : null
    if (lastToken !== null && quantifier !== null) {
      if (lastToken?.type === 'group' && (lastToken.hasQuantifier || lastToken.hasAlternation)) {
        return false
      }

      if (quantifier.unbounded) {
        unboundedQuantifiers++
        if (unboundedQuantifiers > MAX_REGEXP_UNBOUNDED_QUANTIFIERS) return false
      } else {
        boundedQuantifiers++
        if (boundedQuantifiers > MAX_REGEXP_BOUNDED_QUANTIFIERS) return false
        if (quantifier.maxRepetitions > MAX_REGEXP_BOUNDED_QUANTIFIER) return false
        boundedQuantifierProduct *= Math.max(quantifier.maxRepetitions, 1)
        if (boundedQuantifierProduct > MAX_REGEXP_BOUNDED_QUANTIFIER_PRODUCT) return false
      }

      const group = groups.at(-1)
      if (group) group.hasQuantifier = true

      i = quantifier.endIndex
      lastToken = null
      continue
    }

    lastToken = { type: 'atom' }
  }

  return !escaped && !inClass && groups.length === 0
}

function mergeGroupState(target: RegExpGroupState, source: RegExpGroupState): void {
  target.hasQuantifier = target.hasQuantifier || source.hasQuantifier
  target.hasAlternation = target.hasAlternation || source.hasAlternation
}

function parseQuantifier(source: string, index: number): RegExpQuantifier | null {
  const char = source[index]
  if (char === '*' || char === '+') {
    return { endIndex: index, maxRepetitions: Number.POSITIVE_INFINITY, unbounded: true }
  }
  if (char === '?') {
    return { endIndex: index, maxRepetitions: 1, unbounded: false }
  }
  if (char !== '{') return null

  const end = source.indexOf('}', index + 1)
  if (end === -1) return null

  const body = source.slice(index + 1, end)
  const match = /^(\d+)(?:,(\d*))?$/.exec(body)
  if (!match) return null

  const min = Number(match[1])
  const maxText = match[2]
  const unbounded = body.includes(',') && maxText === ''
  return {
    endIndex: end,
    maxRepetitions: unbounded ? Number.POSITIVE_INFINITY : Number(maxText ?? min),
    unbounded,
  }
}
