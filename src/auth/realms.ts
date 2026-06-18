/** Map of known realm names to their base API URLs. */
export const REALM_URLS: Record<string, string> = {
  dev: 'http://api.backblazeb2.xyz:8180',
  eu: 'https://api003.backblazeb2.com',
  production: 'https://api.backblazeb2.com',
  staging: 'https://api.backblaze.net',
}

/**
 * Resolve a realm name to its base API URL.
 * If the realm is not a known name, it is returned as-is (assumed to be a URL).
 *
 * @param realm - The realm name or direct URL to resolve.
 *
 * @returns The base API URL for the given realm.
 */
export function getRealmUrl(realm: string): string {
  return REALM_URLS[realm] ?? realm
}
