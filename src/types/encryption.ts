import { md5Base64 } from '../util/md5.ts'

/** Named constants for the supported server-side encryption algorithms. */
export const EncryptionAlgorithm = {
  /** AES with a 256-bit key. The only algorithm B2 currently supports. */
  Aes256: 'AES256',
} as const

/** Supported server-side encryption algorithm. Derived from {@link EncryptionAlgorithm}. */
export type EncryptionAlgorithm = (typeof EncryptionAlgorithm)[keyof typeof EncryptionAlgorithm]

/**
 * Named constants for the server-side encryption mode used by a file.
 *
 * Most callers should use the {@link SSE_B2}, {@link SSE_NONE}, and
 * {@link sseCustomer} helpers below which return complete
 * {@link EncryptionSetting} objects. These constants are useful when you
 * need the bare mode discriminator (e.g., when introspecting a file's
 * current encryption setting).
 */
export const EncryptionMode = {
  /** B2-managed encryption keys. */
  SseB2: 'SSE-B2',
  /** Customer-provided encryption keys. */
  SseC: 'SSE-C',
  /** No encryption. */
  None: 'none',
} as const

/** Server-side encryption mode for files stored in B2. Derived from {@link EncryptionMode}. */
export type EncryptionMode = (typeof EncryptionMode)[keyof typeof EncryptionMode]

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

/** Server-side encryption using customer-provided keys as returned by B2 responses. */
export interface SseCPublicSetting {
  /** Encryption mode discriminator. Always `'SSE-C'`. */
  readonly mode: 'SSE-C'
  /** Encryption algorithm. Always `'AES256'`. */
  readonly algorithm: EncryptionAlgorithm
}

/** Indicates no server-side encryption is applied. */
export interface NoEncryption {
  /** Encryption mode discriminator. Always `'none'`. */
  readonly mode: 'none'
}

/** No-encryption shape returned by B2 response objects. */
export interface NoEncryptionWireSetting {
  /** Encryption mode discriminator. B2 response payloads use null for no encryption. */
  readonly mode: null
  /** Encryption algorithm. B2 response payloads use null when no encryption is applied. */
  readonly algorithm: null
}

/** Union of all server-side encryption settings: B2-managed, customer-provided, or none. */
export type EncryptionSetting = SseB2Setting | SseCCustomerSetting | NoEncryption

/** Server-side encryption setting returned by B2 response objects. */
export type PublicEncryptionSetting =
  | SseB2Setting
  | SseCPublicSetting
  | NoEncryption
  | NoEncryptionWireSetting

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
  // Prefer Node's Buffer when available (faster), but degrade to btoa() in
  // browsers / Deno / Workers where Buffer isn't a global. We access via
  // globalThis to avoid a hard reference to a Node-only symbol — that would
  // break the type-check in non-Node runtimes (Deno, browser-mode Vitest).
  const g = globalThis as {
    Buffer?: { from(b: Uint8Array): { toString(encoding: string): string } }
  }
  if (g.Buffer) {
    return g.Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

const KEY_REDACTED = '[redacted SSE-C key]'

/**
 * Safe wrapper around an SSE-C customer key. Hides the key bytes from
 * `JSON.stringify`, `console.log`, and Node's `util.inspect`. Use {@link EncryptionKey.fromBytes}
 * to construct one from a raw 32-byte key; the MD5 digest is computed internally.
 */
export class EncryptionKey {
  /** Encryption mode discriminant. Always `'SSE-C'` for this class. */
  readonly mode = 'SSE-C' as const
  /** Encryption algorithm. B2's S3-compatible API only supports AES-256. */
  readonly algorithm: EncryptionAlgorithm = 'AES256'
  /** Base64-encoded 256-bit customer key. Logged as `[redacted SSE-C key]` via `toJSON` / `toString`. */
  readonly customerKey: string
  /** Base64-encoded MD5 digest of the customer key. Required by B2 for integrity verification. */
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
    /** Encryption mode discriminant. */
    mode: 'SSE-C'
    /** Encryption algorithm. */
    algorithm: EncryptionAlgorithm
    /** Always the literal redaction placeholder; the real key never leaves the instance. */
    customerKey: string
    /** Always the literal redaction placeholder; the real MD5 never leaves the instance. */
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
