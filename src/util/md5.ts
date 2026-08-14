/**
 * Encodes raw bytes as base64 in an isomorphic way (Node Buffer fallback to btoa).
 *
 * @param bytes - The raw bytes to encode.
 *
 * @returns The base64-encoded string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as {
    Buffer?: { from(b: Uint8Array): { toString(encoding: string): string } }
  }
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64')

  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

type SyncNodeHash = {
  update(bytes: Uint8Array): SyncNodeHash
  digest(encoding: 'base64'): string
}

type AsyncNodeCryptoLoader = () => Promise<{ createHash?: unknown }>

const loadNodeCrypto: AsyncNodeCryptoLoader = () => import('node:crypto')

function syncNodeCreateHash(): ((algorithm: string) => SyncNodeHash) | null {
  const g = globalThis as {
    process?: {
      getBuiltinModule?: (name: string) => unknown
    }
  }
  const crypto = g.process?.getBuiltinModule?.('node:crypto')
  if (!crypto || typeof crypto !== 'object') return null
  const { createHash } = crypto as { createHash?: unknown }
  return typeof createHash === 'function'
    ? (createHash as (algorithm: string) => SyncNodeHash)
    : null
}

/**
 * Computes the MD5 digest of the given bytes as a base64 string. Prefers
 * `node:crypto` for native speed when available; falls back to a pure-JS
 * implementation in browser / edge runtimes because WebCrypto's
 * `crypto.subtle.digest` deliberately does not support MD5.
 *
 * MD5 is used only for wire-protocol integrity checks, not as a security
 * boundary.
 *
 * @param bytes - The bytes to digest.
 * @param loadCrypto - Optional crypto module loader for runtime fallback tests.
 *
 * @returns The base64-encoded MD5 digest.
 *
 * @internal
 */
export async function md5Base64(
  bytes: Uint8Array,
  loadCrypto: AsyncNodeCryptoLoader = loadNodeCrypto,
): Promise<string> {
  try {
    const { createHash } = await loadCrypto()
    // Vite's browser shim resolves the import but does not implement
    // `createHash`. Probe explicitly so we fall through to the pure-JS path.
    if (typeof createHash !== 'function') throw new Error('createHash unavailable')
    return createHash('md5').update(bytes).digest('base64')
  } catch {
    return md5Base64Sync(bytes)
  }
}

/**
 * Computes the MD5 digest of the given bytes as a base64 string without
 * dynamic imports.
 *
 * @param bytes - The bytes to digest.
 *
 * @returns The base64-encoded MD5 digest.
 *
 * @internal
 */
export function md5Base64Sync(bytes: Uint8Array): string {
  const createHash = syncNodeCreateHash()
  if (createHash) return createHash('md5').update(bytes).digest('base64')

  return bytesToBase64(md5Bytes(bytes))
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
  const originalBitLength = data.length * 8
  const withOne = data.length + 1
  const paddedLength = (withOne + 8 + 63) & ~63
  const msg = new Uint8Array(paddedLength)
  msg.set(data)
  msg[data.length] = 0x80
  const view = new DataView(msg.buffer)
  view.setUint32(paddedLength - 8, originalBitLength >>> 0, true)
  view.setUint32(paddedLength - 4, Math.floor(originalBitLength / 0x1_0000_0000), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const k = Array.from({ length: 64 }, (_, i) =>
    Math.floor(Math.abs(Math.sin(i + 1)) * 0x1_0000_0000),
  )

  const leftRotate = (x: number, c: number) => (x << c) | (x >>> (32 - c))

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0

    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, true))

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }

      const temp = d
      d = c
      c = b
      b =
        (b + leftRotate((a + f + (k[i] as number) + (m[g] as number)) >>> 0, s[i] as number)) >>> 0
      a = temp
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return out
}
