import { afterEach, describe, expect, it, vi } from 'vitest'

const CRYPTO_UNAVAILABLE_MESSAGE =
  'SHA-256 and HMAC-SHA256 require globalThis.crypto.subtle or Node.js node:crypto.'

const hasVitestModuleMocks = typeof vi.doMock === 'function' && typeof vi.doUnmock === 'function'

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

describe('crypto runtime fallback', () => {
  afterEach(() => {
    if (hasVitestModuleMocks) vi.doUnmock('node:crypto')
    restoreCrypto()
    if (typeof vi.resetModules === 'function') vi.resetModules()
  })

  it.skipIf(!hasVitestModuleMocks)(
    'throws a clear error when SHA-256 crypto is unavailable',
    async () => {
      hideWebCrypto()
      vi.doMock('node:crypto', () => {
        throw new Error('node crypto unavailable')
      })

      const { sha256Hex } = await import('./crypto.ts')

      await expect(sha256Hex('data')).rejects.toThrow(CRYPTO_UNAVAILABLE_MESSAGE)
    },
  )

  it.skipIf(!hasVitestModuleMocks)(
    'throws a clear error when HMAC-SHA256 crypto is unavailable',
    async () => {
      hideWebCrypto()
      vi.doMock('node:crypto', () => {
        throw new Error('node crypto unavailable')
      })

      const { hmacSha256 } = await import('./crypto.ts')

      await expect(hmacSha256('key', 'data')).rejects.toThrow(CRYPTO_UNAVAILABLE_MESSAGE)
    },
  )

  it('uses Node crypto for SHA-256 when WebCrypto is unavailable', async () => {
    hideWebCrypto()

    const { sha256Hex } = await import('./crypto.ts')

    await expect(sha256Hex('data')).resolves.toBe(
      '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
    )
  })

  it('uses Node crypto for HMAC-SHA256 when WebCrypto is unavailable', async () => {
    hideWebCrypto()

    const { hexEncode, hmacSha256 } = await import('./crypto.ts')

    await expect(hmacSha256('key', 'data').then(hexEncode)).resolves.toBe(
      '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0',
    )
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
