/**
 * Coerce an unknown caught value to a real error instance.
 *
 * Existing error objects pass through unchanged so call sites preserve
 * the original stack and any subclass identity. Other values are
 * wrapped in a fresh Error whose message is `String(value)`. Centralises
 * the conditional that previously recurred at every async-boundary
 * catch site in the upload, copy, sync, and stream paths.
 *
 * @param value - Value caught from a `try`/`catch` or rejected promise.
 *
 * @returns An `Error` representing `value`.
 */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
