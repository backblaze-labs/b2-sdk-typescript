/**
 * Client-side checksum helpers for download streams.
 *
 * B2 sends `X-Bz-Content-Sha1` on download responses when a whole-file
 * checksum is available. These helpers verify streamed bytes against that
 * header without buffering the full response in memory.
 *
 * @packageDocumentation
 */

import { ChecksumMismatchError } from '../errors/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'

const sha1HexPattern = /^[0-9a-f]{40}$/i

/**
 * Returns whether a normalized `X-Bz-Content-Sha1` value can be verified.
 *
 * @param sha1 - Normalized SHA-1 header value, or null when unavailable.
 *
 * @returns True when the value is a 40-character hexadecimal SHA-1 digest.
 */
export function isVerifiableSha1(sha1: string | null | undefined): sha1 is string {
  return sha1 !== null && sha1 !== undefined && sha1HexPattern.test(sha1)
}

/**
 * Builds the typed error used when downloaded bytes fail SHA-1 verification.
 *
 * @param expectedSha1 - SHA-1 digest advertised by the download response.
 * @param actualSha1 - SHA-1 digest computed from the downloaded bytes.
 *
 * @returns A typed checksum mismatch error.
 */
function createDownloadChecksumMismatchError(
  expectedSha1: string,
  actualSha1: string,
): ChecksumMismatchError {
  const expected = expectedSha1.toLowerCase()
  const actual = actualSha1.toLowerCase()
  return new ChecksumMismatchError({
    status: 400,
    code: 'bad_sha1_checksum',
    message: `Downloaded content SHA-1 mismatch: expected ${expected}, got ${actual}`,
  })
}

/**
 * Throws when a computed download SHA-1 does not match the expected value.
 *
 * @param expectedSha1 - SHA-1 digest advertised by the download response.
 * @param actualSha1 - SHA-1 digest computed from the downloaded bytes.
 *
 * @throws ChecksumMismatchError when the two digests differ.
 */
export function assertDownloadSha1(expectedSha1: string, actualSha1: string): void {
  if (actualSha1.toLowerCase() !== expectedSha1.toLowerCase()) {
    throw createDownloadChecksumMismatchError(expectedSha1, actualSha1)
  }
}

/**
 * Throws when two range responses disagree about the expected whole-file SHA-1.
 *
 * @param expectedSha1 - The first range's verifiable SHA-1, or null when unavailable.
 * @param actualSha1 - The current range's verifiable SHA-1, or null when unavailable.
 *
 * @throws ChecksumMismatchError when the two header states differ.
 */
export function assertDownloadSha1HeaderAgreement(
  expectedSha1: string | null,
  actualSha1: string | null,
): void {
  if (expectedSha1 === actualSha1) return
  const expected = formatSha1ForMessage(expectedSha1)
  const actual = formatSha1ForMessage(actualSha1)
  throw new ChecksumMismatchError({
    status: 400,
    code: 'bad_sha1_checksum',
    message: `Downloaded content SHA-1 header mismatch: expected ${expected}, got ${actual}`,
  })
}

/**
 * Wraps a download stream with whole-body SHA-1 verification.
 *
 * If B2 did not provide a verifiable whole-file SHA-1 (for example,
 * multipart-finished files report `none`), the original stream is returned.
 *
 * @param body - Download response body.
 * @param expectedSha1 - Normalized SHA-1 header value, or null when unavailable.
 *
 * @returns A stream that emits the same bytes and errors on checksum mismatch.
 */
export function verifyDownloadStream(
  body: ReadableStream<Uint8Array>,
  expectedSha1: string | null,
): ReadableStream<Uint8Array> {
  if (!isVerifiableSha1(expectedSha1)) return body

  const sha1 = new IncrementalSha1()
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      await sha1.update(chunk)
      controller.enqueue(chunk)
    },
    async flush() {
      assertDownloadSha1(expectedSha1, await sha1.digest())
    },
  })
  return body.pipeThrough(transform)
}

function formatSha1ForMessage(sha1: string | null): string {
  return sha1 === null ? 'missing or unverifiable' : sha1.toLowerCase()
}
