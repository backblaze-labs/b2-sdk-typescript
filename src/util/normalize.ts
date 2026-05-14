/**
 * Wire-shape → SDK-shape normalization helpers.
 *
 * B2 occasionally uses sentinel strings on the wire where a missing
 * value would be more idiomatic in TypeScript. The biggest offender is
 * `contentSha1: 'none'` on files completed via `b2_finish_large_file`
 * (multipart-finished files don't have a whole-file SHA-1; B2 sends the
 * literal three-letter string). The SDK's `FileVersion.contentSha1` is
 * typed `string | null` to signal that absence — this module collapses
 * the wire sentinel to `null` so callers can write
 * `if (fv.contentSha1) { ... }` without an extra `=== 'none'` guard.
 *
 * Normalization happens at the RawClient boundary so every SDK consumer
 * (RawClient direct users, the high-level facade, the simulator-driven
 * tests, generated docs) sees the same `null` value.
 *
 * @packageDocumentation
 */

/**
 * Collapses the B2 wire sentinel `'none'` (and `undefined`) to `null` for
 * SHA-1-shaped fields. Any other string passes through unchanged.
 *
 * @param raw - SHA-1 string from the wire, or `null`/`undefined`.
 *
 * @returns A hex SHA-1 string, or `null` when the wire said "no hash".
 */
export function normalizeSha1(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === 'none') return null
  return raw
}

/**
 * Returns a new file-version-shaped object with the `contentSha1: 'none'`
 * sentinel collapsed to `null`. Pass-through when the value is already
 * `null` or a real hash. The object reference is preserved if no
 * substitution was needed, so callers paying for change detection
 * (e.g. React memo) see referential stability.
 *
 * @typeParam T - Any object with a `contentSha1: string | null` field.
 *
 * @param fv - The wire-shape file-version object.
 *
 * @returns Either `fv` unchanged or a shallow copy with `contentSha1: null`.
 */
export function normalizeFileVersionSha1<T extends { readonly contentSha1: string | null }>(
  fv: T,
): T {
  return fv.contentSha1 === 'none' ? { ...fv, contentSha1: null } : fv
}

/**
 * Returns a new list-response object with `normalizeFileVersionSha1`
 * applied to every entry in `files`. Used at the `b2_list_file_names` /
 * `b2_list_file_versions` boundary so list output shares the same
 * SHA-1 semantics as the singular endpoints.
 *
 * @typeParam F - Any object with a `contentSha1: string | null` field.
 * @typeParam R - The list-response shape (must have a `files` array of `F`).
 *
 * @param resp - The wire-shape list response.
 *
 * @returns A response with normalized `files`. `resp.files` is a new array.
 */
export function normalizeFileVersionListSha1<
  F extends { readonly contentSha1: string | null },
  R extends { readonly files: readonly F[] },
>(resp: R): R {
  return { ...resp, files: resp.files.map(normalizeFileVersionSha1) }
}
