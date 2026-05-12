export const REALM_URLS: Record<string, string> = {
  production: 'https://api.backblazeb2.com',
  staging: 'https://api.backblazeb2.com',
}

export function getRealmUrl(realm: string): string {
  return REALM_URLS[realm] ?? realm
}
