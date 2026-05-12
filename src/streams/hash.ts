type NodeHasher = { update(data: Uint8Array): void; digest(encoding: string): string }
type NodeHashFactory = (algorithm: string) => NodeHasher

let nodeCreateHash: NodeHashFactory | null | undefined

async function getNodeCreateHash(): Promise<NodeHashFactory | null> {
  if (nodeCreateHash !== undefined) return nodeCreateHash
  try {
    // @ts-ignore -- node:crypto may not exist in browser/edge runtimes
    const crypto = await import('node:crypto')
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
    nodeCreateHash = null
  }
  return nodeCreateHash
}

export class IncrementalSha1 {
  private chunks: Uint8Array[] = []
  private totalLength = 0
  private nodeHash: NodeHasher | null = null
  private initPromise: Promise<void>

  constructor() {
    this.initPromise = getNodeCreateHash().then((factory) => {
      if (factory) this.nodeHash = factory('sha1')
    })
  }

  async update(data: Uint8Array): Promise<void> {
    await this.initPromise
    if (this.nodeHash) {
      this.nodeHash.update(data)
    } else {
      this.chunks.push(new Uint8Array(data))
    }
    this.totalLength += data.byteLength
  }

  async digest(): Promise<string> {
    await this.initPromise
    if (this.nodeHash) {
      return this.nodeHash.digest('hex')
    }

    const combined = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    const hashBuffer = await crypto.subtle.digest('SHA-1', combined.buffer as ArrayBuffer)
    return hexEncode(new Uint8Array(hashBuffer))
  }

  get bytesProcessed(): number {
    return this.totalLength
  }
}

function hexEncode(bytes: Uint8Array): string {
  const hex: string[] = []
  for (const b of bytes) {
    hex.push(b.toString(16).padStart(2, '0'))
  }
  return hex.join('')
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  const factory = await getNodeCreateHash()
  if (factory) {
    const h = factory('sha1')
    h.update(data)
    return h.digest('hex')
  }
  const hashBuffer = await crypto.subtle.digest('SHA-1', data.buffer as ArrayBuffer)
  return hexEncode(new Uint8Array(hashBuffer))
}
