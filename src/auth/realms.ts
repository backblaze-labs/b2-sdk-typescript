import { B2RealmConfigurationError } from '../errors/index.ts'

/**
 * Map of verified realm names to their `b2_authorize_account` base API URLs.
 * The staging URL aligns with Backblaze's official Python SDK realm map.
 * Region-specific API URLs are discovered from the authorize response, so
 * unverified regional aliases are intentionally omitted.
 */
export const REALM_URLS = {
  /** Public production B2 Native API authorize endpoint. */
  production: 'https://api.backblazeb2.com',
  /** Backblaze staging authorize endpoint from the official Python SDK realm map. */
  staging: 'https://api.backblaze.net',
} as const satisfies Record<string, string>

/** Name of a verified built-in auth realm alias. */
export type RealmName = keyof typeof REALM_URLS

const HTTP_REALM_URL_WITH_HOST = /^https?:\/\/[^/?#]/i

function parseAbsoluteRealmUrl(realmUrl: string): URL | null {
  try {
    return new URL(realmUrl)
  } catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true

  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  )
}

function assertAuthorizableRealmScheme(realmUrl: string, url: URL): void {
  if (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    (!HTTP_REALM_URL_WITH_HOST.test(realmUrl) || url.hostname === '')
  ) {
    throw new B2RealmConfigurationError(
      `realm URL must be an absolute HTTP(S) URL with a hostname for authorization: ${realmUrl}`,
    )
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  if (url.protocol === 'http:') {
    throw new B2RealmConfigurationError(
      `refusing to send credentials over plaintext HTTP realm: ${realmUrl}`,
    )
  }
  throw new B2RealmConfigurationError(
    `realm URL must use HTTPS or loopback HTTP for authorization: ${realmUrl}`,
  )
}

/**
 * Validate a realm URL before it is used for credential-bearing authorization.
 * Any accepted custom HTTPS host receives the application key during authorize;
 * do not derive custom realm URLs from untrusted input.
 *
 * @param realmUrl - The resolved realm URL to validate.
 *
 * @throws B2RealmConfigurationError when the realm URL is not absolute, uses an
 * unsupported scheme, or uses non-loopback plaintext HTTP.
 */
export function assertSecureRealmUrl(realmUrl: string): void {
  const url = parseAbsoluteRealmUrl(realmUrl)
  if (url === null) {
    throw new B2RealmConfigurationError(`realm URL must be absolute for authorization: ${realmUrl}`)
  }

  assertAuthorizableRealmScheme(realmUrl, url)
}

/**
 * Validate a realm URL before using it for credential-bearing authorization.
 *
 * @param realmUrl - The resolved realm URL to validate.
 *
 * @throws B2RealmConfigurationError when the realm URL is not absolute, uses an
 * unsupported scheme, or uses non-loopback plaintext HTTP.
 */
export function assertAuthorizableRealmUrl(realmUrl: string): void {
  assertSecureRealmUrl(realmUrl)
}

function isRealmName(realm: string): realm is RealmName {
  return Object.hasOwn(REALM_URLS, realm)
}

/**
 * Resolve a realm name to its base API URL.
 * If the realm is not a known name, it must be a direct base URL. Accepted
 * custom HTTPS hosts receive the application key during authorize; do not
 * derive custom realm URLs from untrusted input.
 *
 * @param realm - The realm name or direct URL to resolve.
 *
 * @returns The base API URL for the given realm.
 *
 * @throws B2RealmConfigurationError when the resolved realm URL is not
 * absolute, uses an unsupported scheme, or uses non-loopback plaintext HTTP.
 */
export function getRealmUrl(realm: string): string {
  const url = isRealmName(realm) ? REALM_URLS[realm] : realm
  assertSecureRealmUrl(url)
  return url
}
