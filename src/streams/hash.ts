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
 * Uses Node.js `crypto` when available, falling back to WebCrypto.
 */
export class IncrementalSha1 {
  /** Buffered chunks for WebCrypto fallback path. */
  private chunks: Uint8Array[] = []
  /** Total bytes fed into the hash so far. */
  private totalLength = 0
  /** Node.js hash instance, or null if using WebCrypto fallback. */
  private nodeHash: NodeHasher | null = null
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
      this.chunks.push(new Uint8Array(data))
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

    /* v8 ignore start -- WebCrypto fallback path, only reachable when node:crypto is unavailable */
    const combined = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    const hashBuffer = await crypto.subtle.digest('SHA-1', combined.buffer as ArrayBuffer)
    return hexEncode(new Uint8Array(hashBuffer))
    /* v8 ignore stop */
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
  /* v8 ignore next 2 -- WebCrypto fallback, only reachable when node:crypto is unavailable */
  const hashBuffer = await crypto.subtle.digest('SHA-1', data.buffer as ArrayBuffer)
  return hexEncode(new Uint8Array(hashBuffer))
}
