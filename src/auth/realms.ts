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

/**
 * Reject realm URLs that would send application-key credentials over plaintext
 * to a non-loopback host.
 *
 * @param realmUrl - The resolved realm URL or custom realm string to validate.
 *
 * @throws Error when the realm URL uses non-loopback plaintext HTTP.
 */
export function assertSecureRealmUrl(realmUrl: string): void {
  let url: URL
  try {
    url = new URL(realmUrl)
  } catch {
    return
  }

  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(`refusing to send credentials over plaintext HTTP realm: ${realmUrl}`)
  }
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
