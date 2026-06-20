import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { utf8Encoder } from '../util/text-codec.ts'

export const FILE_NAME_MAX_BYTES = 1024

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

export function assertNativeDownloadFileName(fileName: string): void {
  assertValidB2FileName(fileName)

  if (fileName.startsWith('/') || fileName.endsWith('/') || fileName.includes('//')) {
    throw new TypeError('fileName cannot start with "/", end with "/", or contain "//".')
  }
}

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
