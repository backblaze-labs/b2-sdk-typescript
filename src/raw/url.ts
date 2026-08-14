/** B2-style API version segment, such as `v1`, `v3`, or `v4`. */
export type B2ApiVersion = `v${number}`

/** URL path options for a B2 API endpoint. */
export interface B2UrlOptions {
  /** Base path prefix before the optional version segment. Defaults to `b2api`. */
  readonly prefix?: string
  /**
   * Optional API version segment. SDK storage endpoints use `v3` and `v4`;
   * Computer Backup endpoints use the same `vN` segment shape under a
   * different prefix, such as `api/backup/v1`.
   */
  readonly version?: B2ApiVersion
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
