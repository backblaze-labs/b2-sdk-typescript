import { afterEach, describe, expect, it, vi } from 'vitest'
import { EncryptionKey } from './encryption.ts'

describe('SSE-C encryption type helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('encodes raw keys without Buffer globals', async () => {
    vi.stubGlobal('Buffer', undefined)

    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
    const key = await EncryptionKey.fromBytes(rawKey)

    // Base64 of the byte sequence 0..31.
    expect(key.customerKey).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')
    expect(key.customerKeyMd5).toBeTruthy()
  })

  it('reports when random key generation has no crypto source', async () => {
    vi.stubGlobal('crypto', undefined)

    await expect(EncryptionKey.generate()).rejects.toThrow(
      'EncryptionKey.generate requires crypto.getRandomValues.',
    )
  })
})
