/**
 * Placeholder authorization table.
 *
 * In production, replace this module with a query against your real ACL store
 * (Postgres row, Redis set, OPA decision, whatever). The signature stays the
 * same: given a user identifier and a desired file key, return `true` if the
 * user is allowed to read it.
 */

/** Maps a user ID to the set of file-name prefixes they may read. */
const policy: Record<string, readonly string[]> = {
  alice: ['photos/', 'docs/'],
  bob: ['docs/'],
  admin: [''], // empty prefix matches everything
}

/**
 * Returns the longest prefix from the user's allowlist that the given key
 * starts with, or null if the user is not allowed to read this key.
 *
 * Returning the matched prefix (not just a boolean) lets the caller mint a
 * download authorization scoped exactly to that prefix: the smallest blast
 * radius the user is entitled to.
 */
export function allowedPrefix(userId: string, fileKey: string): string | null {
  const prefixes = policy[userId]
  if (!prefixes) return null
  let best: string | null = null
  for (const p of prefixes) {
    if (fileKey.startsWith(p) && (best === null || p.length > best.length)) {
      best = p
    }
  }
  return best
}
