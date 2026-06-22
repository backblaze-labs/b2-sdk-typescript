import { toError } from './to-error.ts'

/**
 * Formats an unknown error for public diagnostics without leaking filesystem paths.
 *
 * @param err - Unknown thrown value.
 *
 * @returns A stable, sanitized reason.
 */
export function sanitizeErrorReason(err: unknown): string {
  const error = toError(err)
  const code = (error as { readonly code?: unknown }).code
  if (typeof code === 'string' && code.length > 0) {
    const reason = cleanReason(code)
    if (reason.length > 0) return reason
  }
  const message = cleanReason(error.message)
  if (message.length > 0 && !/[\\/]/.test(message)) return message
  const name = cleanReason(error.name)
  if (name.length > 0) return name
  return 'Error'
}

function cleanReason(value: string): string {
  let cleaned = ''
  let sawNonWhitespace = false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue
    if (!sawNonWhitespace) {
      if (char.trim().length === 0) continue
      sawNonWhitespace = true
    }
    cleaned += char
    if (cleaned.length >= 200) break
  }
  return cleaned.trimEnd()
}
