const sha1HexPattern = /^[0-9a-f]{40}$/i

/**
 * Returns whether a value is a verifiable 40-character hexadecimal SHA-1 digest.
 *
 * @param sha1 - SHA-1 value, or null/undefined when unavailable.
 *
 * @returns True when the value is a 40-character hexadecimal SHA-1 digest.
 */
export function isVerifiableSha1(sha1: string | null | undefined): sha1 is string {
  return sha1 !== null && sha1 !== undefined && sha1HexPattern.test(sha1)
}

/**
 * Normalizes a verifiable SHA-1 digest to lowercase.
 *
 * @param sha1 - SHA-1 value, or null/undefined when unavailable.
 *
 * @returns A lowercase SHA-1 digest, or null when the value is not verifiable.
 */
export function normalizeVerifiableSha1(sha1: string | null | undefined): string | null {
  return isVerifiableSha1(sha1) ? sha1.toLowerCase() : null
}
