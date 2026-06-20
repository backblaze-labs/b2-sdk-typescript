import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { utf8Encoder } from '../util/text-codec.ts'

export const FILE_NAME_MAX_BYTES = 1024
const BUCKET_NAME_MIN = 6
const BUCKET_NAME_MAX = 63
const BUCKET_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/
const BUCKET_NAME_RESERVED_PREFIX = 'b2-'

/**
 * Validate a B2 bucket name before signing or embedding it in a URL path.
 *
 * @param bucketName - Bucket name supplied by the caller.
 *
 * @throws TypeError when the bucket name is empty, contains control characters,
 * is a dot-only path segment, contains path separators, or violates B2 bucket
 * naming rules.
 */
export function assertSafeBucketName(bucketName: string): void {
  if (bucketName.length === 0) {
    throw new TypeError('bucketName must be a non-empty string.')
  }
  if (hasHttpHeaderControlCharacter(bucketName)) {
    throw new TypeError('bucketName must not contain control characters.')
  }
  if (bucketName === '.' || bucketName === '..' || /[/\\]/.test(bucketName)) {
    throw new TypeError('bucketName must not be "." or ".." and must not contain path separators.')
  }
  if (bucketName.length < BUCKET_NAME_MIN || bucketName.length > BUCKET_NAME_MAX) {
    throw new TypeError(`bucketName must be ${BUCKET_NAME_MIN}-${BUCKET_NAME_MAX} characters.`)
  }
  if (!BUCKET_NAME_REGEX.test(bucketName)) {
    throw new TypeError(
      'bucketName must contain only letters, digits, and hyphens, and cannot start or end with a hyphen.',
    )
  }
  if (bucketName.startsWith(BUCKET_NAME_RESERVED_PREFIX)) {
    throw new TypeError(
      `bucketName cannot start with the reserved prefix "${BUCKET_NAME_RESERVED_PREFIX}".`,
    )
  }
}

/**
 * Validate a B2-native download URL file name.
 *
 * Native download-authorization URLs use path-preserving B2 file-name encoding,
 * so this stricter guard rejects slash boundary patterns that would make the
 * URL path ambiguous in common clients.
 *
 * @param fileName - B2 file name supplied by the caller.
 *
 * @throws TypeError when the file name is not valid for the native download
 * authorization URL path.
 */
export function assertNativeDownloadFileName(fileName: string): void {
  assertValidB2FileName(fileName)

  if (fileName.startsWith('/') || fileName.endsWith('/') || fileName.includes('//')) {
    throw new TypeError('fileName cannot start with "/", end with "/", or contain "//".')
  }
}

/**
 * Validate a B2 file name for URL signing safety.
 *
 * This is presign-safety validation, not full native B2 file-name validation.
 * S3-compatible object keys may use leading, trailing, or repeated slash
 * patterns that native B2 download URLs reject. Native download URLs apply the
 * stricter {@link assertNativeDownloadFileName} path-boundary guard. This guard
 * only enforces size, control-character, and dot-segment constraints needed
 * before signing. Dot-only path segments are rejected because URL parsers can
 * normalize them before the request is sent.
 *
 * @param fileName - B2 file name supplied by the caller.
 *
 * @throws TypeError when the file name is empty, too large, contains control
 * characters, or contains dot-only path segments.
 */
export function assertValidB2FileName(fileName: string): void {
  if (fileName.length === 0) {
    throw new TypeError('fileName must be a non-empty string.')
  }

  const bytes = utf8Encoder.encode(fileName)
  if (bytes.byteLength > FILE_NAME_MAX_BYTES) {
    throw new TypeError(
      `fileName must be at most ${FILE_NAME_MAX_BYTES} UTF-8 bytes; received ${bytes.byteLength}.`,
    )
  }

  if (hasHttpHeaderControlCharacter(fileName)) {
    throw new TypeError('fileName must not contain control characters (U+0000-U+001F or U+007F).')
  }

  if (fileName.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(
      'fileName must not contain dot-only path segments because URL parsers can normalize presigned paths.',
    )
  }
}
