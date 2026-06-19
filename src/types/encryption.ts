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

/** Union of all server-side encryption settings: B2-managed, customer-provided, or none. */
export type EncryptionSetting = SseB2Setting | SseCCustomerSetting | NoEncryption

/** Server-side encryption setting returned by B2 response objects. */
export type PublicEncryptionSetting = SseB2Setting | SseCPublicSetting | NoEncryption

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

/**
 * Computes the MD5 digest of the given bytes as a base64 string. Prefers
 * `node:crypto` for native speed when available; falls back to a pure-JS
 * implementation in browser / edge runtimes because WebCrypto's
 * `crypto.subtle.digest` deliberately does not support MD5.
 *
 * MD5 is used here only for SSE-C key integrity (matching the B2 wire
 * protocol). It is **not** a security boundary; the customer key itself is
 * the secret. Bundling a pure-JS fallback keeps `EncryptionKey.fromBytes`
 * isomorphic.
 *
 * @param bytes - The bytes to digest.
 *
 * @returns The base64-encoded MD5 digest.
 */
async function md5Base64(bytes: Uint8Array): Promise<string> {
  try {
    const { createHash } = await import('node:crypto')
    // Vite's browser shim resolves the import but does not implement
    // `createHash`. Probe explicitly so we fall through to the pure-JS path.
    if (typeof createHash !== 'function') throw new Error('createHash unavailable')
    return createHash('md5').update(bytes).digest('base64')
    /* v8 ignore next 3 -- fallback only reachable in non-Node runtimes */
  } catch {
    return bytesToBase64(md5Bytes(bytes))
  }
}

/**
 * Pure-JS MD5 implementation per RFC 1321. Returns the 16-byte digest of the
 * input. Used as a browser fallback for SSE-C key MD5 computation; not
 * intended for security-sensitive purposes (MD5 is broken cryptographically).
 *
 * @param data - The bytes to hash.
 *
 * @returns The 16-byte MD5 digest.
 */
function md5Bytes(data: Uint8Array): Uint8Array {
  // Padding: append 0x80, then zeros, then the original length in bits as a
  // little-endian 64-bit integer, so the total length is a multiple of 64.
  const originalBitLength = data.byteLength * 8
  const padLength = ((data.byteLength + 8) >>> 6) + 1
  const padded = new Uint8Array(padLength * 64)
  padded.set(data)
  padded[data.byteLength] = 0x80
  // Write the 64-bit length (little-endian). JS bitwise ops are 32-bit, so
  // split into low/high halves.
  const lowBits = originalBitLength >>> 0
  const highBits = Math.floor(originalBitLength / 0x1_0000_0000) >>> 0
  const lengthView = new DataView(padded.buffer, padded.byteLength - 8, 8)
  lengthView.setUint32(0, lowBits, true)
  lengthView.setUint32(4, highBits, true)

  // Per-round shift amounts.
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  // Per-round sine-derived constants K[i] = floor(2^32 * abs(sin(i + 1))).
  const k = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ])

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const m = new Uint32Array(16)
  const view = new DataView(padded.buffer)
  for (let block = 0; block < padded.byteLength; block += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(block + i * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        f = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        f = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      const temp = D
      D = C
      C = B
      const sum = (A + f + (k[i] ?? 0) + (m[g] ?? 0)) >>> 0
      const shift = s[i] ?? 0
      const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0
      B = (B + rotated) >>> 0
      A = temp
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return out
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
