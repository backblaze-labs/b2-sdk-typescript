/** Internal wrapper around a Node.js Hash instance. */
type NodeHasher = { update(data: Uint8Array): void; digest(encoding: string): string }

/** Factory that creates a NodeHasher for a given algorithm name. */
type NodeHashFactory = (algorithm: string) => NodeHasher

let nodeCreateHash: NodeHashFactory | null | undefined

/**
 * Lazily loads `node:crypto` and caches the factory. Returns null in non-Node runtimes.
 *
 * @returns The cached hash factory, or null if Node crypto is unavailable.
 */
async function getNodeCreateHash(): Promise<NodeHashFactory | null> {
  if (nodeCreateHash !== undefined) return nodeCreateHash
  try {
    // biome-ignore lint/suspicious/noTsIgnore: isomorphic import — @ts-ignore is silent when node:crypto resolves (Node) and suppresses the error when it doesn't (Deno/browser); @ts-expect-error can't do both
    // @ts-ignore -- node:crypto may not exist in browser/edge runtimes
    const crypto = await import('node:crypto')
    // Vite's browser shim resolves the import but does not implement
    // `createHash`. Probe explicitly so we fall through to the WebCrypto
    // path instead of returning a broken factory.
    if (typeof crypto.createHash !== 'function') throw new Error('createHash unavailable')
    nodeCreateHash = (algo: string) => {
      const h = crypto.createHash(algo)
      return {
        update(data: Uint8Array) {
          h.update(data)
        },
        digest(encoding: string) {
          return h.digest(encoding as 'hex') as string
        },
      }
    }
    /* v8 ignore next 3 -- non-Node runtime fallback, unreachable in Node tests */
  } catch {
    nodeCreateHash = null
  }
  return nodeCreateHash
}

/**
 * Incrementally computes SHA-1 hashes over streaming data.
 * Uses Node.js `crypto` when available, falling back to a dependency-free
 * incremental JavaScript implementation.
 */
export class IncrementalSha1 {
  /** Total bytes fed into the hash so far. */
  private totalLength = 0
  /** Node.js hash instance, or null if using the JavaScript fallback. */
  private nodeHash: NodeHasher | null = null
  /** Streaming JavaScript fallback used when Node crypto is unavailable. */
  private jsHash = new JsSha1Hasher()
  /** Resolves once the crypto backend has been loaded. */
  private initPromise: Promise<void>

  /** Creates a new IncrementalSha1 and lazily initializes the crypto backend. */
  constructor() {
    this.initPromise = getNodeCreateHash().then((factory) => {
      if (factory) this.nodeHash = factory('sha1')
    })
  }

  /**
   * Feed data into the hash. Async because it lazily initializes the crypto backend.
   * @param data - The bytes to include in the hash computation.
   *
   * @returns A promise that resolves once the data has been consumed.
   */
  async update(data: Uint8Array): Promise<void> {
    await this.initPromise
    if (this.nodeHash) {
      this.nodeHash.update(data)
    } else {
      this.jsHash.update(data)
    }
    this.totalLength += data.byteLength
  }

  /**
   * Finalize the hash and return the hex-encoded SHA-1 digest.
   * @returns The lowercase hex-encoded SHA-1 digest of all data fed so far.
   */
  async digest(): Promise<string> {
    await this.initPromise
    if (this.nodeHash) {
      return this.nodeHash.digest('hex')
    }

    /* v8 ignore next -- non-Node runtime fallback, covered by browser-mode tests */
    return this.jsHash.digest()
  }

  /**
   * Total number of bytes fed into the hash so far.
   *
   * @returns The cumulative byte count across all update calls.
   */
  get bytesProcessed(): number {
    return this.totalLength
  }
}

/* v8 ignore start -- JavaScript fallback path, covered by browser-mode tests */
class JsSha1Hasher {
  private h0 = 0x67452301
  private h1 = 0xefcdab89
  private h2 = 0x98badcfe
  private h3 = 0x10325476
  private h4 = 0xc3d2e1f0
  private readonly block = new Uint8Array(64)
  private blockLength = 0
  private bytesProcessed = 0
  private digested = false
  private readonly words = new Uint32Array(80)

  update(data: Uint8Array): void {
    if (this.digested) throw new Error('SHA-1 digest has already been finalized')
    this.bytesProcessed += data.byteLength

    let offset = 0
    if (this.blockLength > 0) {
      const toCopy = Math.min(64 - this.blockLength, data.byteLength)
      this.block.set(data.subarray(0, toCopy), this.blockLength)
      this.blockLength += toCopy
      offset = toCopy
      if (this.blockLength === 64) {
        this.processBlock(this.block, 0)
        this.blockLength = 0
      }
    }

    while (offset + 64 <= data.byteLength) {
      this.processBlock(data, offset)
      offset += 64
    }

    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0)
      this.blockLength = data.byteLength - offset
    }
  }

  digest(): string {
    if (this.digested) throw new Error('SHA-1 digest has already been finalized')
    this.digested = true

    const bitLengthHigh = Math.floor(this.bytesProcessed / 0x20000000)
    const bitLengthLow = (this.bytesProcessed << 3) >>> 0

    this.block[this.blockLength] = 0x80
    this.blockLength++

    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength, 64)
      this.processBlock(this.block, 0)
      this.blockLength = 0
    }

    this.block.fill(0, this.blockLength, 56)
    this.writeUint32(56, bitLengthHigh)
    this.writeUint32(60, bitLengthLow)
    this.processBlock(this.block, 0)

    return (
      wordToHex(this.h0) +
      wordToHex(this.h1) +
      wordToHex(this.h2) +
      wordToHex(this.h3) +
      wordToHex(this.h4)
    )
  }

  private writeUint32(offset: number, value: number): void {
    this.block[offset] = (value >>> 24) & 0xff
    this.block[offset + 1] = (value >>> 16) & 0xff
    this.block[offset + 2] = (value >>> 8) & 0xff
    this.block[offset + 3] = value & 0xff
  }

  private processBlock(block: Uint8Array, offset: number): void {
    const words = this.words
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      words[i] =
        ((block[j] ?? 0) << 24) |
        ((block[j + 1] ?? 0) << 16) |
        ((block[j + 2] ?? 0) << 8) |
        (block[j + 3] ?? 0)
    }

    for (let i = 16; i < 80; i++) {
      words[i] = rotateLeft(
        (words[i - 3] ?? 0) ^ (words[i - 8] ?? 0) ^ (words[i - 14] ?? 0) ^ (words[i - 16] ?? 0),
        1,
      )
    }

    let a = this.h0
    let b = this.h1
    let c = this.h2
    let d = this.h3
    let e = this.h4

    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }

      const temp = (rotateLeft(a, 5) + f + e + k + (words[i] ?? 0)) >>> 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temp
    }

    this.h0 = (this.h0 + a) >>> 0
    this.h1 = (this.h1 + b) >>> 0
    this.h2 = (this.h2 + c) >>> 0
    this.h3 = (this.h3 + d) >>> 0
    this.h4 = (this.h4 + e) >>> 0
  }
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function wordToHex(word: number): string {
  return word.toString(16).padStart(8, '0')
}
/* v8 ignore stop */

/* v8 ignore start -- WebCrypto fallback path, only reachable when node:crypto is unavailable (browser/edge runtimes) */
/**
 * Convert a byte array to a lowercase hex string.
 * @param bytes - The raw bytes to encode as hexadecimal characters.
 *
 * @returns The lowercase hex-encoded string representation of the input bytes.
 */
function hexEncode(bytes: Uint8Array): string {
  const hex: string[] = []
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, '0'))
  }
  return hex.join('')
}
/* v8 ignore stop */

/**
 * Compute the SHA-1 hex digest of a complete byte array in one shot.
 * @param data - The byte array to hash.
 *
 * @returns The lowercase hex-encoded SHA-1 digest of the input.
 */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const factory = await getNodeCreateHash()
  if (factory) {
    const h = factory('sha1')
    h.update(data)
    return h.digest('hex')
  }
  // Pass the view directly (not `data.buffer`) so WebCrypto hashes exactly
  // `data`'s bytes. A subarray shares its parent's buffer, so hashing
  // `.buffer` would digest the whole backing buffer and produce a wrong hash.
  /* v8 ignore next 2 -- WebCrypto fallback, only reachable when node:crypto is unavailable */
  const hashBuffer = await crypto.subtle.digest('SHA-1', data as Uint8Array<ArrayBuffer>)
  return hexEncode(new Uint8Array(hashBuffer))
}
