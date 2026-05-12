/** Supported server-side encryption algorithm. Currently only AES-256 is supported. */
export type EncryptionAlgorithm = 'AES256'

/** Server-side encryption mode for files stored in B2. */
export type EncryptionMode = 'SSE-B2' | 'SSE-C' | 'none'

/** Server-side encryption using B2-managed keys (SSE-B2). */
export interface SseB2Setting {
  /** Encryption mode discriminator. Always `'SSE-B2'`. */
  readonly mode: 'SSE-B2'
  /** Encryption algorithm. Always `'AES256'`. */
  readonly algorithm: EncryptionAlgorithm
}

/** Server-side encryption using customer-provided keys (SSE-C). */
export interface SseCCustomerSetting {
  /** Encryption mode discriminator. Always `'SSE-C'`. */
  readonly mode: 'SSE-C'
  /** Encryption algorithm. Always `'AES256'`. */
  readonly algorithm: EncryptionAlgorithm
  /** Base64-encoded 256-bit encryption key provided by the customer. */
  readonly customerKey: string
  /** Base64-encoded MD5 digest of the customer-provided key, used for integrity verification. */
  readonly customerKeyMd5: string
}

/** Indicates no server-side encryption is applied. */
export interface NoEncryption {
  /** Encryption mode discriminator. Always `'none'`. */
  readonly mode: 'none'
}

/** Union of all server-side encryption settings: B2-managed, customer-provided, or none. */
export type EncryptionSetting = SseB2Setting | SseCCustomerSetting | NoEncryption

/** Pre-built SSE-B2 encryption setting using AES-256. */
export const SSE_B2: SseB2Setting = { mode: 'SSE-B2', algorithm: 'AES256' }

/** Pre-built setting indicating no server-side encryption. */
export const SSE_NONE: NoEncryption = { mode: 'none' }

/**
 * Creates an SSE-C encryption setting with a customer-provided key.
 * @param customerKey - Base64-encoded 256-bit encryption key.
 * @param customerKeyMd5 - Base64-encoded MD5 digest of the key.
 *
 * @returns An SSE-C encryption setting ready to pass to upload or download calls.
 */
export function sseCustomer(customerKey: string, customerKeyMd5: string): SseCCustomerSetting {
  return { mode: 'SSE-C', algorithm: 'AES256', customerKey, customerKeyMd5 }
}

/**
 * Encodes raw bytes as base64 in an isomorphic way (Node Buffer fallback to btoa).
 *
 * @param bytes - The raw bytes to encode.
 *
 * @returns The base64-encoded string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/**
 * Computes the MD5 digest of the given bytes as a base64 string. Uses
 * `node:crypto` when available; otherwise throws because WebCrypto cannot
 * compute MD5 (browsers must precompute and pass the digest explicitly).
 *
 * @param bytes - The bytes to digest.
 *
 * @returns The base64-encoded MD5 digest.
 *
 * @throws If MD5 cannot be computed in the current runtime.
 */
async function md5Base64(bytes: Uint8Array): Promise<string> {
  try {
    const { createHash } = await import('node:crypto')
    return createHash('md5').update(bytes).digest('base64')
  } catch {
    throw new Error(
      'MD5 hashing is not available in this runtime. Precompute the key MD5 and use sseCustomer().',
    )
  }
}

const KEY_REDACTED = '[redacted SSE-C key]'

/**
 * Safe wrapper around an SSE-C customer key. Hides the key bytes from
 * `JSON.stringify`, `console.log`, and Node's `util.inspect`. Use {@link EncryptionKey.fromBytes}
 * to construct one from a raw 32-byte key; the MD5 digest is computed internally.
 */
export class EncryptionKey {
  readonly mode = 'SSE-C' as const
  readonly algorithm: EncryptionAlgorithm = 'AES256'
  readonly customerKey: string
  readonly customerKeyMd5: string

  /**
   * Internal constructor. Use {@link EncryptionKey.fromBytes} or
   * {@link EncryptionKey.fromBase64} instead.
   *
   * @param customerKey - Base64-encoded 256-bit encryption key.
   * @param customerKeyMd5 - Base64-encoded MD5 digest of the key.
   *
   * @internal
   */
  private constructor(customerKey: string, customerKeyMd5: string) {
    this.customerKey = customerKey
    this.customerKeyMd5 = customerKeyMd5
  }

  /**
   * Builds an EncryptionKey from a raw 32-byte (256-bit) key. Computes the
   * required base64 MD5 digest internally.
   *
   * @param rawKey - The raw 256-bit key as bytes. Must be exactly 32 bytes.
   *
   * @returns A safely-wrapped EncryptionKey ready for upload/download.
   *
   * @throws If the key is not exactly 32 bytes.
   */
  static async fromBytes(rawKey: Uint8Array): Promise<EncryptionKey> {
    if (rawKey.byteLength !== 32) {
      throw new Error(`SSE-C key must be exactly 32 bytes (256 bits); got ${rawKey.byteLength}.`)
    }
    const customerKey = bytesToBase64(rawKey)
    const customerKeyMd5 = await md5Base64(rawKey)
    return new EncryptionKey(customerKey, customerKeyMd5)
  }

  /**
   * Builds an EncryptionKey from precomputed base64 strings. Use this in
   * environments where MD5 must be computed externally (e.g., browsers).
   *
   * @param customerKey - Base64-encoded 256-bit encryption key.
   * @param customerKeyMd5 - Base64-encoded MD5 digest of the key.
   *
   * @returns A safely-wrapped EncryptionKey ready for upload/download.
   */
  static fromBase64(customerKey: string, customerKeyMd5: string): EncryptionKey {
    return new EncryptionKey(customerKey, customerKeyMd5)
  }

  /**
   * Hides the key bytes from `JSON.stringify`.
   *
   * @returns A redacted shape: same mode and algorithm, but the key and MD5
   *   replaced with a placeholder string.
   */
  toJSON(): {
    mode: 'SSE-C'
    algorithm: EncryptionAlgorithm
    customerKey: string
    customerKeyMd5: string
  } {
    return {
      mode: this.mode,
      algorithm: this.algorithm,
      customerKey: KEY_REDACTED,
      customerKeyMd5: KEY_REDACTED,
    }
  }

  /**
   * Hides the key bytes from default `toString()`.
   *
   * @returns A short opaque label indicating this is an SSE-C key.
   */
  toString(): string {
    return `[EncryptionKey SSE-C ${KEY_REDACTED}]`
  }

  /**
   * Hides the key bytes from Node's `util.inspect` (and therefore `console.log`).
   *
   * @returns A short opaque label indicating this is an SSE-C key.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }
}
