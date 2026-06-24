import { describe, expect, it } from 'vitest'
import { mergeUploadRetryOptions } from './upload-retry-options.ts'

describe('upload retry option merging', () => {
  it('returns client defaults when no per-call override is provided', () => {
    const retry = {
      initialRetryDelayMs: 100,
      maxRetries: 3,
      maxRetryDelayMs: 1_000,
    }

    expect(mergeUploadRetryOptions(retry, undefined)).toBe(retry)
  })

  it('lets per-call retry settings override client defaults', () => {
    const retry = {
      initialRetryDelayMs: 100,
      maxRetries: 0,
      maxRetryDelayMs: 1_000,
      requestTimeoutMs: 30_000,
    }

    expect(
      mergeUploadRetryOptions(retry, {
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
