export interface RedactUrlForErrorOptions {
  /** Base URL used to resolve relative URL inputs. */
  readonly baseUrl?: string
  /** Placeholder returned when parsing fails. */
  readonly invalidUrlLabel?: string
}

/**
 * Redact a URL before including it in an error message.
 *
 * @param url - Absolute URL, relative URL, or parsed URL to redact.
 * @param options - Optional base URL and invalid-URL placeholder.
 *
 * @returns A URL string with userinfo, query string, and fragment removed.
 */
export function redactUrlForError(
  url: string | URL,
  options: RedactUrlForErrorOptions = {},
): string {
  try {
    const parsed =
      url instanceof URL
        ? new URL(url)
        : options.baseUrl !== undefined
          ? new URL(url, options.baseUrl)
          : new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return options.invalidUrlLabel ?? '<invalid URL>'
  }
}
