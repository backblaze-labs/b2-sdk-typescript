import { arrayBufferFor } from '../util/bytes.ts'
import { hexEncode } from '../util/crypto.ts'

/** Internal wrapper around a Node.js Hash instance. */
type NodeHasher = { update(data: Uint8Array): void; digest(encoding: string): string }

/** Factory that creates a NodeHasher for a given algorithm name. */
type NodeHashFactory = (algorithm: string) => NodeHasher

/** Shared interface for dependency-free streaming hash fallbacks. */
type JsHasher = { update(data: Uint8Array): void; digest(): string }

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
  } catch {
    /* v8 ignore next -- non-Node runtime fallback, unreachable in Node coverage. */
    nodeCreateHash = null
  }
  return nodeCreateHash
}

class IncrementalHash {
  /** Total bytes fed into the hash so far. */
  private totalLength = 0
  /** Node.js hash instance, or null if using the JavaScript fallback. */
  private nodeHash: NodeHasher | null = null
  /** Resolves once the crypto backend has been loaded. */
  private initPromise: Promise<void>

  constructor(
    private readonly algorithm: 'sha1' | 'sha256',
    private readonly jsHash: JsHasher,
  ) {
    this.initPromise = getNodeCreateHash().then((factory) => {
      if (factory) this.nodeHash = factory(this.algorithm)
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
      /* v8 ignore next -- WebCrypto fallback is exercised by browser-mode tests. */
      this.jsHash.update(data)
    }
    this.totalLength += data.byteLength
  }

  /**
   * Finalize the hash and return the hex-encoded digest.
   * @returns The lowercase hex-encoded digest of all data fed so far.
   */
  async digest(): Promise<string> {
    await this.initPromise
    if (this.nodeHash) {
      return this.nodeHash.digest('hex')
    }

    /* v8 ignore next -- non-Node runtime fallback, exercised by browser-mode tests */
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

/**
 * Incrementally computes SHA-1 hashes over streaming data.
 * Uses Node.js `crypto` when available, falling back to a dependency-free
 * incremental JavaScript implementation.
 */
export class IncrementalSha1 extends IncrementalHash {
  /** Creates a new IncrementalSha1 and lazily initializes the crypto backend. */
  constructor() {
    super('sha1', new JsSha1Hasher())
  }
}

/**
 * Incrementally computes SHA-256 hashes over streaming data.
 * Uses Node.js `crypto` when available, falling back to a dependency-free
 * incremental JavaScript implementation.
 */
export class IncrementalSha256 extends IncrementalHash {
  /** Creates a new IncrementalSha256 and lazily initializes the crypto backend. */
  constructor() {
    super('sha256', new JsSha256Hasher())
  }
}

/* v8 ignore start -- JavaScript fallback path, exercised by browser-mode tests */
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

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

class JsSha256Hasher {
  private h0: number = SHA256_INITIAL_STATE[0]
  private h1: number = SHA256_INITIAL_STATE[1]
  private h2: number = SHA256_INITIAL_STATE[2]
  private h3: number = SHA256_INITIAL_STATE[3]
  private h4: number = SHA256_INITIAL_STATE[4]
  private h5: number = SHA256_INITIAL_STATE[5]
  private h6: number = SHA256_INITIAL_STATE[6]
  private h7: number = SHA256_INITIAL_STATE[7]
  private readonly block = new Uint8Array(64)
  private blockLength = 0
  private bytesProcessed = 0
  private digested = false
  private readonly words = new Uint32Array(64)

  update(data: Uint8Array): void {
    if (this.digested) throw new Error('SHA-256 digest has already been finalized')
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
    if (this.digested) throw new Error('SHA-256 digest has already been finalized')
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
    writeUint32(this.block, 56, bitLengthHigh)
    writeUint32(this.block, 60, bitLengthLow)
    this.processBlock(this.block, 0)

    return [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7]
      .map(wordToHex)
      .join('')
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

    for (let i = 16; i < 64; i++) {
      words[i] =
        (smallSigma1(words[i - 2] ?? 0) +
          (words[i - 7] ?? 0) +
          smallSigma0(words[i - 15] ?? 0) +
          (words[i - 16] ?? 0)) >>>
        0
    }

    let a = this.h0
    let b = this.h1
    let c = this.h2
    let d = this.h3
    let e = this.h4
    let f = this.h5
    let g = this.h6
    let h = this.h7

    for (let i = 0; i < 64; i++) {
      const t1 =
        (h + bigSigma1(e) + sha256Choose(e, f, g) + (SHA256_K[i] ?? 0) + (words[i] ?? 0)) >>> 0
      const t2 = (bigSigma0(a) + sha256Majority(a, b, c)) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    this.h0 = (this.h0 + a) >>> 0
    this.h1 = (this.h1 + b) >>> 0
    this.h2 = (this.h2 + c) >>> 0
    this.h3 = (this.h3 + d) >>> 0
    this.h4 = (this.h4 + e) >>> 0
    this.h5 = (this.h5 + f) >>> 0
    this.h6 = (this.h6 + g) >>> 0
    this.h7 = (this.h7 + h) >>> 0
  }
}

function writeUint32(block: Uint8Array, offset: number, value: number): void {
  block[offset] = (value >>> 24) & 0xff
  block[offset + 1] = (value >>> 16) & 0xff
  block[offset + 2] = (value >>> 8) & 0xff
  block[offset + 3] = value & 0xff
}

function rotateRight(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0
}

function smallSigma0(value: number): number {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)
}

function smallSigma1(value: number): number {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)
}

function bigSigma0(value: number): number {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22)
}

function bigSigma1(value: number): number {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25)
}

function sha256Choose(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z)
}

function sha256Majority(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z)
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
  // Copy subarray and SharedArrayBuffer-backed views so WebCrypto hashes
  // exactly `data`'s visible bytes with a plain ArrayBuffer.
  /* v8 ignore start -- WebCrypto fallback, only reachable when node:crypto is unavailable */
  const hashBuffer = await crypto.subtle.digest('SHA-1', arrayBufferFor(data))
  return hexEncode(new Uint8Array(hashBuffer))
  /* v8 ignore stop */
}

/**
 * Compute the SHA-256 hex digest of a complete byte array in one shot.
 * @param data - The byte array to hash.
 *
 * @returns The lowercase hex-encoded SHA-256 digest of the input.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const factory = await getNodeCreateHash()
  if (factory) {
    const h = factory('sha256')
    h.update(data)
    return h.digest('hex')
  }
  // Copy subarray and SharedArrayBuffer-backed views so WebCrypto hashes
  // exactly `data`'s visible bytes with a plain ArrayBuffer.
  /* v8 ignore start -- WebCrypto fallback, only reachable when node:crypto is unavailable */
  const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBufferFor(data))
  return hexEncode(new Uint8Array(hashBuffer))
  /* v8 ignore stop */
}
