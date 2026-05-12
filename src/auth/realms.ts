/** Map of known realm names to their base API URLs. */
export const REALM_URLS: Record<string, string> = {
  production: 'https://api.backblazeb2.com',
  staging: 'https://api.backblazeb2.com',
}

/**
 * Resolve a realm name to its base API URL.
 * If the realm is not a known name, it is returned as-is (assumed to be a URL).
 */
export function getRealmUrl(realm: string): string {
  return REALM_URLS[realm] ?? realm
}
