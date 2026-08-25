import { afterEach, describe, expect, it } from 'vitest'
import { EncryptionKey } from './encryption.ts'

const originalBufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property)
    return
  }
  Object.defineProperty(target, property, descriptor)
}

function hideGlobal(property: 'Buffer' | 'crypto'): void {
  Object.defineProperty(globalThis, property, {
    configurable: true,
    value: undefined,
    writable: true,
  })
}

describe('SSE-C encryption type helpers', () => {
  afterEach(() => {
    restoreProperty(globalThis, 'Buffer', originalBufferDescriptor)
    restoreProperty(globalThis, 'crypto', originalCryptoDescriptor)
  })

  it('encodes raw keys without Buffer globals', async () => {
    hideGlobal('Buffer')

    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
    const key = await EncryptionKey.fromBytes(rawKey)

    // Base64 of the byte sequence 0..31.
    expect(key.customerKey).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')
    expect(key.customerKeyMd5).toBeTruthy()
  })

  it('reports when random key generation has no crypto source', async () => {
    hideGlobal('crypto')

    await expect(EncryptionKey.generate()).rejects.toThrow(
      'EncryptionKey.generate requires crypto.getRandomValues.',
    )
  })
})
