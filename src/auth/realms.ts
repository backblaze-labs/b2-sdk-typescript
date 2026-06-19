/**
 * Map of verified realm names to their `b2_authorize_account` base API URLs.
 * The staging URL aligns with Backblaze's official Python SDK realm map.
 * Region-specific API URLs are discovered from the authorize response, so
 * unverified regional aliases are intentionally omitted.
 */
export const REALM_URLS: Record<string, string> = {
  production: 'https://api.backblazeb2.com',
  staging: 'https://api.backblaze.net',
}

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

function assertNoPlaintextNonLoopbackRealmUrl(realmUrl: string, url: URL): void {
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(`refusing to send credentials over plaintext HTTP realm: ${realmUrl}`)
  }
}

/**
 * Reject realm URLs that would send application-key credentials over plaintext
 * to a non-loopback host.
 *
 * @param realmUrl - The resolved realm URL or custom realm string to validate.
 *
 * @throws Error when the realm URL uses non-loopback plaintext HTTP.
 */
export function assertSecureRealmUrl(realmUrl: string): void {
  const url = parseAbsoluteRealmUrl(realmUrl)
  if (url === null) return

  assertNoPlaintextNonLoopbackRealmUrl(realmUrl, url)
}

/**
 * Validate a realm URL before using it for credential-bearing authorization.
 *
 * @param realmUrl - The resolved realm URL to validate.
 *
 * @throws Error when the realm URL is not absolute or uses non-loopback plaintext HTTP.
 */
export function assertAuthorizableRealmUrl(realmUrl: string): void {
  const url = parseAbsoluteRealmUrl(realmUrl)
  if (url === null) {
    throw new Error(`realm URL must be absolute for authorization: ${realmUrl}`)
  }

  assertNoPlaintextNonLoopbackRealmUrl(realmUrl, url)
}

/**
 * Resolve a realm name to its base API URL.
 * If the realm is not a known name, it is returned as-is (assumed to be a URL).
 *
 * @param realm - The realm name or direct URL to resolve.
 *
 * @returns The base API URL for the given realm.
 *
 * @throws Error when the resolved realm URL uses non-loopback plaintext HTTP.
 */
export function getRealmUrl(realm: string): string {
  const url = REALM_URLS[realm] ?? realm
  assertSecureRealmUrl(url)
  return url
}
