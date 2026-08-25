import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EncryptionKey,
  redactSseCKeyMaterial,
  SSE_C_KEY_REDACTION,
  sseCustomer,
} from './encryption.ts'

describe('SSE-C encryption type helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('encodes raw keys without Buffer globals', async () => {
    vi.stubGlobal('Buffer', undefined)

    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
    const key = await EncryptionKey.fromBytes(rawKey)

    expect(key.customerKey).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')
    expect(key.customerKeyMd5).toBeTruthy()
  })

  it('reports when random key generation has no crypto source', async () => {
    vi.stubGlobal('crypto', undefined)

    await expect(EncryptionKey.generate()).rejects.toThrow(
      'EncryptionKey.generate requires crypto.getRandomValues.',
    )
  })

  it('redacts key material without adding an encryption mode when omitted', () => {
    const material = sseCustomer('base64-key', 'base64-md5')
    const redacted = redactSseCKeyMaterial(material, { label: 'SseCUploadKey' })

    expect(redacted.customerKey).toBe('base64-key')
    expect(redacted.customerKeyMd5).toBe('base64-md5')
    expect(Object.keys(redacted)).toEqual(['algorithm'])
    expect(JSON.stringify(redacted)).toBe(
      JSON.stringify({
        algorithm: 'AES256',
        customerKey: SSE_C_KEY_REDACTION,
        customerKeyMd5: SSE_C_KEY_REDACTION,
      }),
    )
    expect(String(redacted)).toBe(`[SseCUploadKey ${SSE_C_KEY_REDACTION}]`)
  })

  it('keeps an explicit encryption mode in redacted diagnostics', () => {
    const material = sseCustomer('base64-key', 'base64-md5')
    const redacted = redactSseCKeyMaterial(material, {
      label: 'SseCUploadKey',
      mode: 'SSE-C',
    })

    expect(Object.keys(redacted)).toEqual(['mode', 'algorithm'])
    expect(JSON.parse(JSON.stringify(redacted))).toEqual({
      mode: 'SSE-C',
      algorithm: 'AES256',
      customerKey: SSE_C_KEY_REDACTION,
      customerKeyMd5: SSE_C_KEY_REDACTION,
    })
  })
})
