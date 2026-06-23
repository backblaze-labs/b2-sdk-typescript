import { describe, expect, it } from 'vitest'
import { redactUrlForError } from './url-redaction.ts'

describe('redactUrlForError', () => {
  it('redacts credentials, query strings, fragments, and deep paths', () => {
    expect(redactUrlForError('https://user:pass@example.com/a/b/c?token=secret#frag')).toBe(
      'https://example.com/...',
    )
  })

  it('resolves relative URLs against a base URL before redacting', () => {
    expect(
      redactUrlForError('../object?Authorization=secret', { baseUrl: 'https://f.example/b/' }),
    ).toBe('https://f.example/...')
  })

  it('returns the configured label for invalid URLs', () => {
    expect(redactUrlForError('not a url', { invalidUrlLabel: '<redacted>' })).toBe('<redacted>')
  })
})
