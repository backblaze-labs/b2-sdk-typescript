import { describe, expect, it } from 'vitest'
import { getClientUploadRetryOptions, setClientUploadRetryOptions } from './upload-retry-options.ts'

describe('upload retry options registry', () => {
  it('returns options stored for a client object', () => {
    const client = {}
    const options = { maxRetries: 3, initialRetryDelayMs: 10, maxRetryDelayMs: 100 }

    setClientUploadRetryOptions(client, options)

    expect(getClientUploadRetryOptions(client)).toBe(options)
  })

  it('throws when a client has no stored upload retry options', () => {
    expect(() => getClientUploadRetryOptions({})).toThrow(
      'B2Client upload retry options are unavailable',
    )
  })
})
