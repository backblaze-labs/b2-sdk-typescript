import { arrayBufferFor } from './bytes.ts'
import { utf8Encoder } from './text-codec.ts'

const CRYPTO_UNAVAILABLE_MESSAGE =
  'SHA-256 and HMAC-SHA256 require globalThis.crypto.subtle or Node.js node:crypto.'

type NodeHash = {
  update(data: Uint8Array): NodeHash
  digest(encoding: 'hex'): string
}

type NodeHmac = {
  update(data: Uint8Array): NodeHmac
  digest(): Uint8Array
}

type NodeCrypto = {
  createHash(algorithm: string): NodeHash
  createHmac(algorithm: string, key: Uint8Array): NodeHmac
}

/**
 * Convert bytes to a lowercase hex string.
 *
 * @param bytes - The raw bytes to encode as hexadecimal characters.
 *
 * @returns The lowercase hex-encoded string representation of the input bytes.
 */
export function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Compute a SHA-256 digest and return it as lowercase hex.
 *
 * @param data - UTF-8 string or raw bytes to digest.
 *
 * @returns The lowercase hex-encoded SHA-256 digest.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = bytesFor(data)
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', arrayBufferFor(bytes))
    return hexEncode(new Uint8Array(digest))
  }

  const { createHash } = await importNodeCrypto()
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Compute an HMAC-SHA256 digest.
 *
 * @param key - UTF-8 string or raw bytes for the HMAC key.
 * @param data - UTF-8 string or raw bytes to sign.
 *
 * @returns The raw HMAC-SHA256 digest bytes.
 */
export async function hmacSha256(
  key: string | Uint8Array,
  data: string | Uint8Array,
): Promise<Uint8Array> {
  const keyBytes = bytesFor(key)
  const dataBytes = bytesFor(data)

  if (globalThis.crypto?.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      arrayBufferFor(keyBytes),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await globalThis.crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      arrayBufferFor(dataBytes),
    )
    return new Uint8Array(signature)
  }

  const { createHmac } = await importNodeCrypto()
  return new Uint8Array(createHmac('sha256', keyBytes).update(dataBytes).digest())
}

function bytesFor(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? utf8Encoder.encode(data) : data
}

async function importNodeCrypto(): Promise<NodeCrypto> {
  try {
    // biome-ignore lint/suspicious/noTsIgnore: isomorphic import -- @ts-ignore is silent when node:crypto resolves and suppresses the error when it does not
    // @ts-ignore -- node:crypto may not exist in browser/edge runtimes
    return (await import('node:crypto')) as NodeCrypto
  } catch (err) {
    throw new Error(CRYPTO_UNAVAILABLE_MESSAGE, { cause: err })
  }
}
