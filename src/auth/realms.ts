import { B2RealmConfigurationError } from '../errors/index.ts'
import { redactUrlForError } from '../internal/url-redaction.ts'

/** Name of a verified built-in auth realm alias. */
export type RealmName = 'production' | 'staging'

const VERIFIED_REALM_URLS = {
  /** Public production B2 Native API authorize endpoint. */
  production: 'https://api.backblazeb2.com',
  /** Backblaze staging authorize endpoint from the official Python SDK realm map. */
  staging: 'https://api.backblaze.net',
} as const satisfies Record<RealmName, string>

/**
 * Map of verified realm names to their `b2_authorize_account` base API URLs.
 * The staging URL aligns with Backblaze's official Python SDK realm map.
 * Region-specific API URLs are discovered from the authorize response, so
 * unverified regional aliases are intentionally omitted.
 */
export const REALM_URLS: Record<string, string> = VERIFIED_REALM_URLS

// `new URL('https:example.com')` normalizes to `https://example.com/`;
// require the raw URL to use authority syntax before credentials are sent.
const HTTP_REALM_URL_WITH_HOST = /^https?:\/\/[^/?#]/i

function parseAbsoluteRealmUrl(realmUrl: string): URL | null {
  try {
    return new URL(realmUrl)
  } catch {
    return null
  }
}

function realmUrlForError(realmUrl: string, url = parseAbsoluteRealmUrl(realmUrl)): string {
  return redactUrlForError(url ?? realmUrl, { invalidUrlLabel: '<invalid realm URL>' })
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === '[::1]' || host === '::1') return true

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
      `realm URL must be an absolute HTTP(S) URL with a hostname for authorization: ${realmUrlForError(realmUrl, url)}`,
    )
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return
  if (url.protocol === 'http:') {
    throw new B2RealmConfigurationError(
      `refusing to send credentials over plaintext HTTP realm: ${realmUrlForError(realmUrl, url)}`,
    )
  }
  throw new B2RealmConfigurationError(
    `realm URL must use HTTPS or loopback IP HTTP for authorization: ${realmUrlForError(realmUrl, url)}`,
  )
}

function assertRealmBaseUrl(realmUrl: string, url: URL): void {
  if (url.username === '' && url.password === '' && url.search === '' && url.hash === '') return
  throw new B2RealmConfigurationError(
    `realm URL must not include userinfo, query, or fragment for authorization: ${realmUrlForError(realmUrl, url)}`,
  )
}

/**
 * Validate a realm URL before it is used for credential-bearing authorization.
 * Any accepted custom HTTPS host receives the application key during authorize;
 * do not derive custom realm URLs from untrusted input. Realm URLs must be base
 * URLs without userinfo, query strings, or fragments.
 *
 * @param realmUrl - The resolved realm URL to validate.
 *
 * @throws B2RealmConfigurationError when the realm URL is not absolute, is not
 * a base URL, uses an unsupported scheme, or uses non-loopback plaintext HTTP.
 * Loopback IP HTTP is accepted only for local testing and sends the application
 * key unencrypted to whichever process is listening on that address and port.
 */
export function assertSecureRealmUrl(realmUrl: string): void {
  const url = parseAbsoluteRealmUrl(realmUrl)
  if (url === null) {
    throw new B2RealmConfigurationError(
      `realm URL must be absolute for authorization: ${realmUrlForError(realmUrl, url)}`,
    )
  }

  assertRealmBaseUrl(realmUrl, url)
  assertAuthorizableRealmScheme(realmUrl, url)
}

function isRealmName(realm: string): realm is RealmName {
  return Object.hasOwn(VERIFIED_REALM_URLS, realm)
}

/**
 * Resolve a realm name to its base API URL. Unknown strings are returned
 * unchanged so callers can resolve custom aliases before authorization.
 *
 * @param realm - The realm name or direct URL to resolve.
 *
 * @returns The mapped base API URL for a known realm, otherwise `realm`.
 */
export function getRealmUrl(realm: string): string {
  return isRealmName(realm) ? VERIFIED_REALM_URLS[realm] : realm
}
