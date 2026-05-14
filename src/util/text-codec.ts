/**
 * Shared UTF-8 codec singletons.
 *
 * Every byte boundary in this SDK is UTF-8: JSON request and response bodies,
 * webhook payloads, simulator stream chunks, and B2 percent-encoding inputs.
 * Allocating a fresh `TextEncoder` / `TextDecoder` per call is wasteful and
 * makes the encoding assumption invisible. Importing these constants makes
 * "we use UTF-8" explicit at every call site and avoids the per-call
 * allocation entirely.
 *
 * Both classes are spec-defined as stateless across encode / decode calls,
 * so a process-wide singleton is safe.
 *
 * @packageDocumentation
 */

/**
 * Process-wide UTF-8 `TextEncoder`. Use this instead of
 * `new TextEncoder()` for any string → bytes conversion in the SDK.
 */
export const utf8Encoder = new TextEncoder()

/**
 * Process-wide UTF-8 `TextDecoder`. Use this instead of
 * `new TextDecoder()` for any bytes → string conversion in the SDK.
 */
export const utf8Decoder = new TextDecoder()
