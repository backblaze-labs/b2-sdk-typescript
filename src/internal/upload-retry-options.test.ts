import { describe, expect, it } from 'vitest'
import {
  getClientUploadRetryOptions,
  mergeClientUploadRetryOptions,
  setClientUploadRetryOptions,
} from './upload-retry-options.ts'

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

  it('returns client defaults when no per-call override is provided', () => {
    const client = {}
    const retry = {
      initialRetryDelayMs: 100,
      maxRetries: 3,
      maxRetryDelayMs: 1_000,
    }
    setClientUploadRetryOptions(client, retry)

    expect(mergeClientUploadRetryOptions(client, undefined)).toBe(retry)
  })

  it('lets per-call retry settings override client defaults', () => {
    const client = {}
    setClientUploadRetryOptions(client, {
      initialRetryDelayMs: 100,
      maxRetries: 0,
      maxRetryDelayMs: 1_000,
      requestTimeoutMs: 30_000,
    })

    expect(
      mergeClientUploadRetryOptions(client, {
        maxRetries: 2,
        requestTimeoutMs: 10_000,
      }),
    ).toEqual({
      initialRetryDelayMs: 100,
      maxRetries: 2,
      maxRetryDelayMs: 1_000,
      requestTimeoutMs: 10_000,
    })
  })
})
