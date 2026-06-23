import {
  BUCKET_NAME_MAX,
  BUCKET_NAME_MIN,
  BUCKET_NAME_RESERVED_PREFIX,
  FILE_NAME_MAX_BYTES,
  getB2FileNameByteLength,
  hasB2FileNameControlCharacter,
  hasValidB2BucketNameShape,
} from '../internal/b2-naming.ts'

export { FILE_NAME_MAX_BYTES }

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
  if (typeof bucketName !== 'string' || bucketName.length === 0) {
    throw new TypeError('bucketName must be a non-empty string.')
  }
  if (hasB2FileNameControlCharacter(bucketName)) {
    throw new TypeError('bucketName must not contain control characters.')
  }
  if (bucketName === '.' || bucketName === '..' || /[/\\]/.test(bucketName)) {
    throw new TypeError('bucketName must not be "." or ".." and must not contain path separators.')
  }
  if (bucketName.length < BUCKET_NAME_MIN || bucketName.length > BUCKET_NAME_MAX) {
    throw new TypeError(`bucketName must be ${BUCKET_NAME_MIN}-${BUCKET_NAME_MAX} characters.`)
  }
  if (!hasValidB2BucketNameShape(bucketName)) {
    throw new TypeError(
      'bucketName must contain only letters, digits, hyphens, and periods, cannot start or end with punctuation, and cannot contain consecutive periods.',
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
 * Validate a B2 file name for the deprecated native URL helper that percent
 * encodes the whole name as one component. Slash-boundary and dot-segment names
 * embedded in longer paths are safe in that legacy URL shape and remain
 * accepted for compatibility. Exact "." or ".." names are rejected because
 * common URL parsers can normalize the resulting bearer URL path.
 *
 * @param fileName - B2 file name supplied by the caller.
 */
export function assertLegacyNativeDownloadFileName(fileName: string): void {
  assertB2FileNameCore(fileName)
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
  assertB2FileNameCore(fileName)

  if (fileName.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(
      'fileName must not contain dot-only path segments because URL parsers can normalize presigned paths.',
    )
  }
}

function assertB2FileNameCore(fileName: string): void {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new TypeError('fileName must be a non-empty string.')
  }

  if (fileName === '.' || fileName === '..') {
    throw new TypeError('fileName cannot be exactly "." or "..".')
  }

  const byteLength = getB2FileNameByteLength(fileName)
  if (byteLength === null) {
    throw new TypeError(`fileName must be at most ${FILE_NAME_MAX_BYTES} UTF-8 bytes.`)
  }

  if (hasB2FileNameControlCharacter(fileName)) {
    throw new TypeError('fileName must not contain control characters (U+0000-U+001F or U+007F).')
  }
}
