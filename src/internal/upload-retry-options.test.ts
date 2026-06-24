import { describe, expect, it } from 'vitest'
import { getClientUploadRetryOptions, setClientUploadRetryOptions } from './upload-retry-options.ts'

describe('client upload retry options registry', () => {
  it('stores resolved upload retry options out-of-band', () => {
    const client = {}
    const retry = {
      initialRetryDelayMs: 100,
      maxRetries: 3,
      maxRetryDelayMs: 1_000,
    }

    setClientUploadRetryOptions(client, retry)

    expect(getClientUploadRetryOptions(client)).toBe(retry)
  })

  it('rejects lookups for unregistered clients', () => {
    expect(() => getClientUploadRetryOptions({})).toThrow(
      'B2Client upload retry options are unavailable',
    )
  })
})
