/**
 * Detect HTTP header value control characters.
 *
 * Header values used by this SDK must not contain C0 controls or DEL. Rejecting
 * them before signing avoids relying on later whitespace normalization to
 * neutralize CR/LF header injection.
 *
 * @param value - Header value to inspect.
 *
 * @returns `true` when the value contains a disallowed control character.
 */
export function hasHttpHeaderControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }

  return false
}
