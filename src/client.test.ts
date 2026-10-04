import { describe, expect, it } from 'vitest'
import { B2Client } from './client.ts'

describe('B2Client constructor options', () => {
  it('creates default FetchTransport when no transport is provided', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })
    expect(client.raw).toBeTruthy()
    expect(client.accountInfo).toBeTruthy()
  })

  it('creates FetchTransport with custom userAgent', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      userAgent: 'my-app/2.0',
    })
    expect(client.raw).toBeTruthy()
  })

  it('passes retry options through', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      retry: { maxRetries: 10 },
    })
    expect(client.raw).toBeTruthy()
  })
})

describe('error classification', () => {
  it('classifies expired_auth_token as retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({
      status: 401,
      code: 'expired_auth_token',
      message: 'Token expired',
    })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ExpiredAuthTokenError')
  })

  it('classifies cap_exceeded as not retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({ status: 403, code: 'cap_exceeded', message: 'Cap exceeded' })
    expect(error.retryable).toBe(false)
    expect(error.name).toBe('CapExceededError')
  })

  it('classifies 503 as retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({ status: 503, code: 'service_unavailable', message: 'Try again' })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ServiceUnavailableError')
  })
})

describe('IncrementalSha1', () => {
  it('computes correct SHA1 for known input', async () => {
    const { IncrementalSha1 } = await import('./streams/hash.ts')
    const sha1 = new IncrementalSha1()
    await sha1.update(new TextEncoder().encode('hello'))
    const digest = await sha1.digest()
    expect(digest).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })

  it('handles multiple updates', async () => {
    const { IncrementalSha1, sha1Hex } = await import('./streams/hash.ts')
    const sha1 = new IncrementalSha1()
    await sha1.update(new TextEncoder().encode('hello'))
    await sha1.update(new TextEncoder().encode(' world'))
    const digest = await sha1.digest()

    const singlePass = await sha1Hex(new TextEncoder().encode('hello world'))
    expect(digest).toBe(singlePass)
  })
})

describe('encoding', () => {
  it('percent-encodes file names correctly', async () => {
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.ts')
    expect(encodeFileName('photos/2026/cat.jpg')).toBe('photos/2026/cat.jpg')
    expect(encodeFileName('path with spaces')).toBe('path%20with%20spaces')
    expect(decodeFileName('path%20with%20spaces')).toBe('path with spaces')
  })

  it('handles unicode in file names', async () => {
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.ts')
    const original = 'docs/日本語.txt'
    const encoded = encodeFileName(original)
    expect(encoded).not.toContain('日')
    expect(decodeFileName(encoded)).toBe(original)
  })
})
