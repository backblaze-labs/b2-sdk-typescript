/**
 * Inclusive byte range plan for a single chunk of a larger sequence.
 *
 * Carries every commonly-needed shape so the three call sites (multipart
 * upload, server-side multipart copy, parallel-ranged download) can
 * destructure the fields they want without re-deriving them:
 *
 * - `partNumber` is 1-based to match the B2 `b2_upload_part` /
 *   `b2_copy_part` wire format.
 * - `index` is 0-based for callers that key into a `Map` or array slot.
 * - `offset` + `length` are the upload-style framing (where in the
 *   source to read, how many bytes).
 * - `start` + `end` (both inclusive) are the HTTP `Range:` /
 *   `Content-Range:` framing.
 */
export interface RangePlan {
  /** 1-based part number for B2 multipart endpoints. */
  readonly partNumber: number
  /** 0-based slot index for in-memory bookkeeping. */
  readonly index: number
  /** Inclusive byte offset where this range begins. */
  readonly offset: number
  /** Number of bytes in this range. */
  readonly length: number
  /** Alias for {@link offset} — convenient for `bytes=start-end` formatters. */
  readonly start: number
  /** Inclusive byte offset where this range ends (`offset + length - 1`). */
  readonly end: number
}

/**
 * Lays out a sequence of contiguous, non-overlapping byte ranges over
 * `[0, totalSize)`. Every produced range is at most `chunkSize` bytes
 * long; the final range may be shorter if `totalSize` is not a multiple
 * of `chunkSize`.
 *
 * Replaces three near-identical hand-rolled loops in
 * `upload/large.ts`, `copy/large.ts`, and `download/parallel.ts`.
 *
 * @param totalSize - Total number of bytes to cover.
 * @param chunkSize - Target size of each range in bytes (last range may be smaller).
 *
 * @returns Ordered, non-overlapping range plans. Empty array when `totalSize === 0`.
 */
export function planRanges(totalSize: number, chunkSize: number): RangePlan[] {
  const plans: RangePlan[] = []
  let offset = 0
  let index = 0
  while (offset < totalSize) {
    const length = Math.min(chunkSize, totalSize - offset)
    const end = offset + length - 1
    plans.push({
      partNumber: index + 1,
      index,
      offset,
      length,
      start: offset,
      end,
    })
    offset += length
    index++
  }
  return plans
}

/**
 * Format an HTTP `Range:` request-header value covering the given
 * inclusive byte offsets. Centralises the `bytes=<start>-<end>` template
 * so the upload, copy, and download paths agree on syntax.
 *
 * @param start - Inclusive starting byte.
 * @param end - Inclusive ending byte.
 *
 * @returns The header value (e.g. `'bytes=0-99'`).
 */
export function byteRangeHeader(start: number, end: number): string {
  return `bytes=${start}-${end}`
}
