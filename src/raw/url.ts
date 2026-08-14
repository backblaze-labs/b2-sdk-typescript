/** URL path options for a B2 API endpoint. */
export interface B2UrlOptions {
  /** Base path prefix before the optional version segment. Defaults to `b2api`. */
  readonly prefix?: string
  /** Optional API version segment, such as `v3`, `v4`, or `v1`. */
  readonly version?: string
  /** Endpoint name appended after the prefix and optional version. */
  readonly endpoint: string
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
  const base = baseUrl.replace(/\/+$/, '')
  const path = [prefix, version, endpoint]
    .filter((segment): segment is string => segment !== undefined)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/')

  return path.length === 0 ? base : `${base}/${path}`
}
