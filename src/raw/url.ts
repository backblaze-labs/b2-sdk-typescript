/**
 * B2-style API version segment, such as `v1`, `v3`, or `v4`.
 *
 * The template-literal type documents the compile-time shape; use
 * {@link isB2ApiVersion} when accepting untyped runtime input.
 */
export type B2ApiVersion = `v${number}`

const SLASH = '/'
const BACKSLASH = '\\'
const VERSION_PREFIX = 'v'
const VERSION_DIGITS = '0123456789'
const URL_DELIMITERS = ['?', '#'] as const

/** URL path options for a B2 API endpoint. */
export interface B2UrlOptions {
  /** Base path prefix before the optional version segment. Defaults to `b2api`. */
  readonly prefix?: string
  /**
   * Optional API version segment. SDK-built B2 native storage endpoints use
   * the current published `v4` segment; Computer Backup endpoints use the same
   * `vN` segment shape under a different prefix, such as `api/backup/v1`.
   */
  readonly version?: B2ApiVersion
  /** Endpoint name appended after the prefix and optional version. */
  readonly endpoint: string
}

/** URL path options for a B2 API surface before the endpoint is selected. */
export type B2EndpointUrlOptions = Omit<B2UrlOptions, 'endpoint'>

/**
 * Returns true when `value` is a B2 API version segment of the form `vN`.
 *
 * @param value - Candidate API version segment.
 *
 * @returns Whether the value is a valid B2 API version segment.
 */
export function isB2ApiVersion(value: string): value is B2ApiVersion {
  if (!value.startsWith(VERSION_PREFIX) || value.length === VERSION_PREFIX.length) return false

  for (let index = VERSION_PREFIX.length; index < value.length; index += 1) {
    const digit = value[index]
    if (digit === undefined || !VERSION_DIGITS.includes(digit)) return false
  }

  return true
}

function assertB2ApiVersion(value: string): asserts value is B2ApiVersion {
  if (!isB2ApiVersion(value)) {
    throw new TypeError('Invalid version: expected a B2 API version segment like "v3"')
  }
}

function trimSlashes(
  value: string,
  { leading, trailing }: { readonly leading: boolean; readonly trailing: boolean },
): string {
  let start = 0
  let end = value.length

  while (leading && start < end && value[start] === SLASH) {
    start += 1
  }
  while (trailing && end > start && value[end - 1] === SLASH) {
    end -= 1
  }

  return start === 0 && end === value.length ? value : value.slice(start, end)
}

function hasUrlDelimiter(value: string): boolean {
  return URL_DELIMITERS.some((delimiter) => value.includes(delimiter))
}

function hasEncodedPathDelimiter(value: string): boolean {
  const lowerValue = value.toLowerCase()
  return (
    lowerValue.includes('%2f') ||
    lowerValue.includes('%3f') ||
    lowerValue.includes('%23') ||
    lowerValue.includes('%5c')
  )
}

function withDotEscapesDecoded(value: string): string {
  let decoded = ''
  let index = 0

  while (index < value.length) {
    if (value.slice(index, index + 3).toLowerCase() === '%2e') {
      decoded += '.'
      index += 3
    } else {
      decoded += value[index]
      index += 1
    }
  }

  return decoded
}

function isTraversalComponent(value: string): boolean {
  const decoded = withDotEscapesDecoded(value)
  return decoded === '.' || decoded === '..'
}

function validatePathComponent(component: string, optionName: string): void {
  if (component.length === 0) {
    throw new TypeError(`Invalid ${optionName}: path components must not be empty`)
  }
  if (hasUrlDelimiter(component)) {
    throw new TypeError(`Invalid ${optionName}: path components must not contain "?" or "#"`)
  }
  if (component.includes(BACKSLASH)) {
    throw new TypeError(`Invalid ${optionName}: path components must not contain "\\"`)
  }
  if (hasEncodedPathDelimiter(component)) {
    throw new TypeError(
      `Invalid ${optionName}: path components must not contain encoded "/", "\\", "?", or "#"`,
    )
  }
  if (isTraversalComponent(component)) {
    throw new TypeError(`Invalid ${optionName}: path components must not be "." or ".."`)
  }
}

function preparePathPrefix(prefix: string): string {
  const trimmed = trimSlashes(prefix, { leading: true, trailing: true })
  if (trimmed.length === 0) return ''

  for (const component of trimmed.split(SLASH)) {
    validatePathComponent(component, 'prefix')
  }

  return trimmed
}

function preparePathSegment(segment: string, optionName: string): string {
  const trimmed = trimSlashes(segment, { leading: true, trailing: true })
  if (trimmed.length === 0) return ''
  if (trimmed.includes(SLASH)) {
    throw new TypeError(`Invalid ${optionName}: expected a single path segment`)
  }

  validatePathComponent(trimmed, optionName)
  return trimmed
}

function prepareVersionSegment(version: B2ApiVersion): B2ApiVersion {
  const trimmed = preparePathSegment(version, 'version')
  assertB2ApiVersion(trimmed)
  return trimmed
}

/**
 * Builds a B2 API endpoint URL from a base URL, path prefix, optional version,
 * and endpoint name.
 *
 * @param baseUrl - API or download base URL.
 * @param options - Path prefix, optional version, and endpoint name.
 *
 * @returns The absolute endpoint URL.
 */
export function b2Url(
  baseUrl: string,
  { prefix = 'b2api', version, endpoint }: B2UrlOptions,
): string {
  const base = trimSlashes(baseUrl, { leading: false, trailing: true })
  const path = [
    preparePathPrefix(prefix),
    version === undefined ? undefined : prepareVersionSegment(version),
    preparePathSegment(endpoint, 'endpoint'),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .filter((segment) => segment.length > 0)
    .join(SLASH)

  return path.length === 0 ? base : `${base}/${path}`
}
