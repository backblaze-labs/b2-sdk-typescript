import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { utf8Encoder } from '../util/text-codec.ts'

export const FILE_NAME_MAX_BYTES = 1024

/**
 * Validate a B2 bucket name before embedding it in a URL path.
 *
 * @param bucketName - Bucket name supplied by the caller.
 *
 * @throws TypeError when the bucket name is empty, contains control characters,
 * is a dot-only path segment, or contains path separators.
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
 * Validate a B2 file name before signing or composing an object URL.
 *
 * B2 and S3 object names can contain slashes, but dot-only path segments are
 * rejected because URL parsers can normalize them before the request is sent.
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
