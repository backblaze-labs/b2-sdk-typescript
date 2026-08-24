import { utf8Encoder } from '../util/text-codec.ts'

/**
 * Characters that B2 treats as safe (not percent-encoded) in file names.
 *
 * Per the B2 docs, everything except `a-z A-Z 0-9 - . _ ~ / ! $ & ' ( ) * + , ; = : @`
 * must be percent-encoded using UTF-8 byte values.
 */
const SAFE_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/".split(''),
)

const FILE_INFO_VALUE_SAFE_CHARS = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'.split(''),
)

function encodeWithSafeChars(value: string, safeChars: ReadonlySet<string>): string {
  const encoded: string[] = []
  for (const char of value) {
    if (safeChars.has(char)) {
      encoded.push(char)
    } else {
      const bytes = utf8Encoder.encode(char)
      for (const byte of bytes) {
        encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      }
    }
  }
  return encoded.join('')
}

/**
 * Percent-encodes a file name using the B2-specific encoding rules.
 *
 * Unlike standard `encodeURIComponent`, B2 keeps `/` and several other
 * characters unencoded while encoding all other non-ASCII and special
 * characters as uppercase percent-encoded UTF-8 bytes.
 *
 * @param name - The raw (unencoded) file name.
 *
 * @returns The percent-encoded file name suitable for `X-Bz-File-Name` headers.
 */
export function encodeFileName(name: string): string {
  return encodeWithSafeChars(name, SAFE_CHARS)
}

/**
 * Percent-encodes a file-info value using the stricter B2 metadata value rules.
 *
 * File-info values must be decoded by B2 before storage. Live B2 rejects comma
 * and other RFC punctuation when left raw in these values, so only RFC 3986
 * unreserved characters are passed through.
 *
 * @param value - The raw (unencoded) file-info value.
 *
 * @returns The percent-encoded value suitable for `X-Bz-Info-*` header values.
 */
function encodeFileInfoValue(value: string): string {
  return encodeWithSafeChars(value, FILE_INFO_VALUE_SAFE_CHARS)
}

/**
 * Decodes a B2 percent-encoded file name back to a plain string.
 *
 * B2 percent-encoding is compatible with standard `decodeURIComponent`,
 * so this is a thin wrapper.
 *
 * @param encoded - The percent-encoded file name from B2.
 *
 * @returns The decoded file name.
 */
export function decodeFileName(encoded: string): string {
  return decodeURIComponent(encoded)
}

/**
 * Converts a file-info map into `X-Bz-Info-*` HTTP headers.
 *
 * Keys use B2 file-name encoding. Values use stricter B2 file-info value
 * encoding so punctuation such as commas is percent-encoded before B2 decodes
 * and validates stored metadata.
 *
 * @param fileInfo - Key/value pairs to attach as custom file info, or `undefined`.
 *
 * @returns A record of header name/value pairs (empty if `fileInfo` is `undefined`).
 */
export function buildFileInfoHeaders(
  fileInfo: Record<string, string> | undefined,
): Record<string, string> {
  if (!fileInfo) return {}
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(fileInfo)) {
    headers[`X-Bz-Info-${encodeFileName(key)}`] = encodeFileInfoValue(value)
  }
  return headers
}

/**
 * Extracts custom file-info key/value pairs from B2 response headers.
 *
 * Scans for headers prefixed with `x-bz-info-` and decodes both the
 * key suffix and value using {@link decodeFileName}.
 *
 * @param headers - The HTTP response headers from a B2 download or file-info call.
 *
 * @returns A record of decoded file-info key/value pairs.
 */
export function parseFileInfoHeaders(headers: Headers): Record<string, string> {
  const info: Record<string, string> = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower.startsWith('x-bz-info-')) {
      const infoKey = decodeFileName(lower.slice('x-bz-info-'.length))
      info[infoKey] = decodeFileName(value)
    }
  })
  return info
}
