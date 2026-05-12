/**
 * Characters that B2 treats as safe (not percent-encoded) in file names.
 *
 * Per the B2 docs, everything except `a-z A-Z 0-9 - . _ ~ / ! $ & ' ( ) * + , ; = : @`
 * must be percent-encoded using UTF-8 byte values.
 */
const SAFE_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/".split(''),
)

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
  const encoded: string[] = []
  for (const char of name) {
    if (SAFE_CHARS.has(char)) {
      encoded.push(char)
    } else {
      const bytes = new TextEncoder().encode(char)
      for (const byte of bytes) {
        encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      }
    }
  }
  return encoded.join('')
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
 * Both keys and values are percent-encoded with {@link encodeFileName}
 * to satisfy B2 header requirements.
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
    headers[`X-Bz-Info-${encodeFileName(key)}`] = encodeFileName(value)
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
