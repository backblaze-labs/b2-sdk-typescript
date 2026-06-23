import { toError } from '../util/to-error.ts'

/**
 * Formats local filesystem errors without including host filesystem paths.
 * @param err - Unknown filesystem error.
 *
 * @returns A path-independent code or error name.
 */
export function localFilesystemErrorReason(err: unknown): string {
  const error = toError(err)
  const code = cleanFilesystemErrorPart((error as { readonly code?: unknown }).code)
  if (code !== '') return code

  const name = cleanFilesystemErrorPart(error.name)
  if (name !== '') return name

  return 'Error'
}

function cleanFilesystemErrorPart(value: unknown): string {
  if (typeof value !== 'string') return ''
  let cleaned = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code === 0x7f) continue
    cleaned += char
    if (cleaned.length >= 80) break
  }
  const trimmed = cleaned.trim()
  return /[\\/]/.test(trimmed) ? '' : trimmed
}
