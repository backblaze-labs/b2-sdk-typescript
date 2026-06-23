import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { utf8Encoder } from '../util/text-codec.ts'

/** Minimum B2 bucket-name length per https://www.backblaze.com/apidocs/b2-create-bucket. */
export const BUCKET_NAME_MIN = 6
/** Maximum B2 bucket-name length per https://www.backblaze.com/apidocs/b2-create-bucket. */
export const BUCKET_NAME_MAX = 63
/** Reserved prefix: B2 forbids consumer-created buckets starting with `b2-`. */
export const BUCKET_NAME_RESERVED_PREFIX = 'b2-'
/** Max file-name length is 1024 bytes, UTF-8 encoded. */
export const FILE_NAME_MAX_BYTES = 1024

const BUCKET_NAME_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/

/**
 * B2 bucket names may contain letters, digits, hyphens, and periods, but
 * cannot start/end with punctuation or contain adjacent periods.
 *
 * @param name - Candidate bucket name.
 *
 * @returns Whether the name satisfies the shared B2 bucket-name shape rules.
 */
export function hasValidB2BucketNameShape(name: string): boolean {
  return BUCKET_NAME_REGEX.test(name) && !name.includes('..')
}

/**
 * Checks for control characters that B2 rejects in names and HTTP header values.
 *
 * @param name - Candidate name.
 *
 * @returns Whether the name contains a rejected control character.
 */
export function hasB2FileNameControlCharacter(name: string): boolean {
  return hasHttpHeaderControlCharacter(name)
}

/**
 * Enforces the 1024-byte B2 file-name limit. Very long strings fail before
 * full UTF-8 encoding so untrusted input cannot force unbounded allocation.
 *
 * @param name - Candidate file name.
 *
 * @returns The UTF-8 byte length when it is within the B2 limit, otherwise `null`.
 */
export function getB2FileNameByteLength(name: string): number | null {
  if (name.length > FILE_NAME_MAX_BYTES) return null

  const bytes = utf8Encoder.encode(name)
  return bytes.byteLength > FILE_NAME_MAX_BYTES ? null : bytes.byteLength
}
