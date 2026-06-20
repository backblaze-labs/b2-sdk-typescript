import { afterEach, describe, expect, it, vi } from 'vitest'

const CRYPTO_UNAVAILABLE_MESSAGE =
  'SHA-256 and HMAC-SHA256 require globalThis.crypto.subtle or Node.js node:crypto.'

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

describe('crypto runtime fallback', () => {
  afterEach(() => {
    vi.doUnmock('node:crypto')
    restoreCrypto()
    vi.resetModules()
  })

  it('throws a clear error when SHA-256 crypto is unavailable', async () => {
    hideWebCrypto()
    vi.doMock('node:crypto', () => {
      throw new Error('node crypto unavailable')
    })

    const { sha256Hex } = await import('./crypto.ts')

    await expect(sha256Hex('data')).rejects.toThrow(CRYPTO_UNAVAILABLE_MESSAGE)
  })

  it('throws a clear error when HMAC-SHA256 crypto is unavailable', async () => {
    hideWebCrypto()
    vi.doMock('node:crypto', () => {
      throw new Error('node crypto unavailable')
    })

    const { hmacSha256 } = await import('./crypto.ts')

    await expect(hmacSha256('key', 'data')).rejects.toThrow(CRYPTO_UNAVAILABLE_MESSAGE)
  })
})

function hideWebCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
}

function restoreCrypto(): void {
  if (originalCryptoDescriptor) {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'crypto')
  }
}
