// B2-specific percent-encoding for X-Bz-File-Name
// Per the B2 docs: encode everything except: a-z A-Z 0-9 - . _ ~ / ! $ & ' ( ) * + , ; = : @
const SAFE_CHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/".split(''),
)

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

export function decodeFileName(encoded: string): string {
  return decodeURIComponent(encoded)
}

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
