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
  if (typeof code === 'string' && code.length > 0) return code
  const message = error.message.trim()
  if (message.length > 0 && !/[\\/]/.test(message)) return message
  if (error.name.length > 0) return error.name
  return 'Error'
}
