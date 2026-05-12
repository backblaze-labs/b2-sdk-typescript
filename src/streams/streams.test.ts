import { describe, expect, it, vi } from 'vitest'
import { EncryptionKey } from '../types/encryption.ts'
import { IncrementalSha1, sha1Hex } from './hash.ts'
import { ProgressTracker } from './progress.ts'
import { BlobSource, BufferSource, StreamSource, toContentSource } from './source.ts'

// Well-known SHA-1 digests for verification.
const SHA1_EMPTY = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
const SHA1_HELLO = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'

// ---------------------------------------------------------------------------
// hash.ts
// ---------------------------------------------------------------------------

describe('IncrementalSha1', () => {
  it('produces the correct digest after a single update', async () => {
    const sha = new IncrementalSha1()
    await sha.update(new TextEncoder().encode('hello'))
    expect(await sha.digest()).toBe(SHA1_HELLO)
  })

  it('produces the correct digest after multiple updates', async () => {
    const sha = new IncrementalSha1()
    await sha.update(new TextEncoder().encode('hel'))
    await sha.update(new TextEncoder().encode('lo'))
    expect(await sha.digest()).toBe(SHA1_HELLO)
  })

  it('tracks bytesProcessed correctly', async () => {
    const sha = new IncrementalSha1()
    expect(sha.bytesProcessed).toBe(0)

    await sha.update(new Uint8Array(10))
    expect(sha.bytesProcessed).toBe(10)

    await sha.update(new Uint8Array(5))
    expect(sha.bytesProcessed).toBe(15)
  })

  it('digest returns a hex string (hexDigest equivalent)', async () => {
    const sha = new IncrementalSha1()
    await sha.update(new Uint8Array(0))
    const result = await sha.digest()
    // Must be a 40-character lowercase hex string (SHA-1 output).
    expect(result).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('sha1Hex', () => {
  it('returns the correct SHA-1 for an empty buffer', async () => {
    const result = await sha1Hex(new Uint8Array(0))
    expect(result).toBe(SHA1_EMPTY)
  })

  it('returns the correct SHA-1 for "hello"', async () => {
    const result = await sha1Hex(new TextEncoder().encode('hello'))
    expect(result).toBe(SHA1_HELLO)
  })
})

// ---------------------------------------------------------------------------
// progress.ts
// ---------------------------------------------------------------------------

describe('ProgressTracker', () => {
  it('sets up initial state via constructor parameters', () => {
    const listener = vi.fn()
    new ProgressTracker(listener, 1000, 5)

    // No events should have been emitted yet.
    expect(listener).not.toHaveBeenCalled()
  })

  it('addBytes accumulates and emits progress events', () => {
    const listener = vi.fn()
    const tracker = new ProgressTracker(listener, 500, null)

    tracker.addBytes(100)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ bytesTransferred: 100, totalBytes: 500 }),
    )

    tracker.addBytes(200)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ bytesTransferred: 300, totalBytes: 500 }),
    )
  })

  it('completePart increments partsCompleted and emits events', () => {
    const listener = vi.fn()
    const tracker = new ProgressTracker(listener, null, 3)

    tracker.completePart()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ partsCompleted: 1, totalParts: 3 }),
    )

    tracker.completePart()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ partsCompleted: 2, totalParts: 3 }),
    )
  })

  it('does not throw when listener is undefined', () => {
    const tracker = new ProgressTracker(undefined, 100, null)
    expect(() => tracker.addBytes(50)).not.toThrow()
    expect(() => tracker.completePart()).not.toThrow()
  })

  it('elapsedMs increases over time', () => {
    const listener = vi.fn()

    // First call to Date.now() is inside the constructor (startTime).
    // Subsequent calls happen inside emit().
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const tracker = new ProgressTracker(listener, null, null)

    now = 1050
    tracker.addBytes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ elapsedMs: 50 }))

    now = 1200
    tracker.addBytes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ elapsedMs: 200 }))

    vi.restoreAllMocks()
  })

  it('passes totalBytes and totalParts through to events', () => {
    const listener = vi.fn()
    const tracker = new ProgressTracker(listener, 2048, 4)

    tracker.addBytes(0)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ totalBytes: 2048, totalParts: 4 }),
    )
  })
})

// ---------------------------------------------------------------------------
// source.ts
// ---------------------------------------------------------------------------

describe('BufferSource', () => {
  const data = new TextEncoder().encode('hello world')

  it('constructor sets size from the buffer byte length', () => {
    const src = new BufferSource(data)
    expect(src.size).toBe(data.byteLength)
  })

  it('slice returns the correct sub-buffer', async () => {
    const src = new BufferSource(data)
    const sliced = src.slice(0, 5)
    expect(sliced.size).toBe(5)

    const ab = await sliced.toArrayBuffer()
    const text = new TextDecoder().decode(ab)
    expect(text).toBe('hello')
  })

  it('stream returns a ReadableStream that yields the buffer', async () => {
    const src = new BufferSource(data)
    const reader = src.stream().getReader()
    const { value, done } = await reader.read()
    expect(done).toBe(false)
    expect(value).toEqual(data)

    const end = await reader.read()
    expect(end.done).toBe(true)
  })

  it('toArrayBuffer returns an ArrayBuffer with the correct contents', async () => {
    const src = new BufferSource(data)
    const ab = await src.toArrayBuffer()
    expect(ab).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(ab)).toEqual(data)
  })
})

describe('BlobSource', () => {
  const content = new TextEncoder().encode('blob content')
  const blob = new Blob([content])

  it('constructor sets size from the Blob', () => {
    const src = new BlobSource(blob)
    expect(src.size).toBe(blob.size)
  })

  it('slice returns a sub-blob source with the correct size', () => {
    const src = new BlobSource(blob)
    const sliced = src.slice(0, 4)
    expect(sliced.size).toBe(4)
  })

  it('stream returns a ReadableStream', async () => {
    const src = new BlobSource(blob)
    const stream = src.stream()
    expect(stream).toBeInstanceOf(ReadableStream)

    // Consume the stream to verify it produces data.
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    expect(totalLength).toBe(content.byteLength)
  })

  it('toArrayBuffer returns the data', async () => {
    const src = new BlobSource(blob)
    const ab = await src.toArrayBuffer()
    expect(ab).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(ab)).toEqual(content)
  })
})

describe('StreamSource', () => {
  function makeStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
  }

  it('constructor sets size from the provided value', () => {
    const src = new StreamSource(makeStream(new Uint8Array(10)), 10)
    expect(src.size).toBe(10)
  })

  it('stream returns the underlying ReadableStream', async () => {
    const data = new TextEncoder().encode('stream data')
    const src = new StreamSource(makeStream(data), data.byteLength)
    const reader = src.stream().getReader()
    const { value } = await reader.read()
    expect(value).toEqual(data)
  })

  it('stream throws on the second call', () => {
    const src = new StreamSource(makeStream(new Uint8Array(1)), 1)
    src.stream() // first call succeeds
    expect(() => src.stream()).toThrow('StreamSource can only be consumed once.')
  })

  it('slice always throws', () => {
    const src = new StreamSource(makeStream(new Uint8Array(1)), 1)
    expect(() => (src as unknown as { slice: () => void }).slice()).toThrow(
      'StreamSource does not support slicing. Buffer the stream first.',
    )
  })

  it('toArrayBuffer reads and concatenates all chunks', async () => {
    const chunk1 = new Uint8Array([1, 2, 3])
    const chunk2 = new Uint8Array([4, 5])
    const chunk3 = new Uint8Array([6])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk1)
        controller.enqueue(chunk2)
        controller.enqueue(chunk3)
        controller.close()
      },
    })
    const src = new StreamSource(stream, 6)
    const ab = await src.toArrayBuffer()
    expect(ab).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
  })

  it('toArrayBuffer throws on second call (stream consumed)', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
    const src = new StreamSource(stream, 1)
    await src.toArrayBuffer()
    await expect(src.toArrayBuffer()).rejects.toThrow('StreamSource can only be consumed once.')
  })
})

describe('toContentSource', () => {
  it('converts a Uint8Array to a BufferSource', () => {
    const buf = new Uint8Array([1, 2, 3])
    const src = toContentSource(buf)
    expect(src).toBeInstanceOf(BufferSource)
    expect(src.size).toBe(3)
  })

  it('converts a Blob to a BlobSource', () => {
    const blob = new Blob([new Uint8Array([10, 20])])
    const src = toContentSource(blob)
    expect(src).toBeInstanceOf(BlobSource)
    expect(src.size).toBe(2)
  })

  it('converts a ReadableStream to a StreamSource', () => {
    const rs = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]))
        c.close()
      },
    })
    const src = toContentSource(rs, 1)
    expect(src).toBeInstanceOf(StreamSource)
    expect(src.size).toBe(1)
  })

  it('throws when a ReadableStream is provided without a size', () => {
    const rs = new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    })
    expect(() => toContentSource(rs)).toThrow(
      'size is required when using a ReadableStream as input.',
    )
  })
})

// ---------------------------------------------------------------------------
// hash.ts - additional coverage for hexEncode, sha1Hex, and WebCrypto paths
// ---------------------------------------------------------------------------

describe('sha1Hex (one-shot)', () => {
  it('computes correct SHA-1 for a multi-byte UTF-8 string', async () => {
    // "abc" has a well-known SHA-1 digest
    const data = new TextEncoder().encode('abc')
    const result = await sha1Hex(data)
    expect(result).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  it('returns a 40-char lowercase hex string for arbitrary binary data', async () => {
    const data = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0x01])
    const result = await sha1Hex(data)
    expect(result).toMatch(/^[0-9a-f]{40}$/)
  })

  it('handles a large buffer without error', async () => {
    // 64 KB buffer filled with a repeating pattern
    const data = new Uint8Array(65536)
    for (let i = 0; i < data.length; i++) {
      data[i] = i & 0xff
    }
    const result = await sha1Hex(data)
    expect(result).toMatch(/^[0-9a-f]{40}$/)
    // Verify determinism: same input produces same output
    const result2 = await sha1Hex(data)
    expect(result).toBe(result2)
  })

  it('produces distinct digests for different inputs', async () => {
    const a = await sha1Hex(new TextEncoder().encode('alpha'))
    const b = await sha1Hex(new TextEncoder().encode('beta'))
    expect(a).not.toBe(b)
  })
})

describe('IncrementalSha1 - hexEncode edge cases', () => {
  it('correctly encodes bytes with leading zeros (0x00..0x0f)', async () => {
    // Feed bytes 0x00 through 0x0f and verify the digest is correct.
    // This exercises hexEncode's padStart(2, '0') logic.
    const data = new Uint8Array([0x00, 0x01, 0x02, 0x0a, 0x0f])
    const sha = new IncrementalSha1()
    await sha.update(data)
    const digest = await sha.digest()
    expect(digest).toMatch(/^[0-9a-f]{40}$/)

    // Cross-check with one-shot sha1Hex
    const expected = await sha1Hex(data)
    expect(digest).toBe(expected)
  })

  it('produces consistent results for incremental vs one-shot', async () => {
    const fullData = new TextEncoder().encode('the quick brown fox jumps over the lazy dog')
    const oneShot = await sha1Hex(fullData)

    // Feed in small chunks
    const sha = new IncrementalSha1()
    const chunkSize = 7
    for (let i = 0; i < fullData.length; i += chunkSize) {
      await sha.update(fullData.slice(i, i + chunkSize))
    }
    const incremental = await sha.digest()

    expect(incremental).toBe(oneShot)
  })

  it('handles an empty update followed by non-empty data', async () => {
    const sha = new IncrementalSha1()
    await sha.update(new Uint8Array(0))
    await sha.update(new TextEncoder().encode('hello'))
    const result = await sha.digest()
    expect(result).toBe(SHA1_HELLO)
  })

  it('handles single-byte inputs', async () => {
    const sha = new IncrementalSha1()
    await sha.update(new Uint8Array([0x61])) // 'a'
    const result = await sha.digest()
    // SHA-1 of 'a'
    expect(result).toBe('86f7e437faa5a7fce15d1ddcb9eaeaea377667b8')
  })

  it('handles all-zero byte array', async () => {
    const data = new Uint8Array(16) // 16 zero bytes
    const sha = new IncrementalSha1()
    await sha.update(data)
    const digest = await sha.digest()
    const expected = await sha1Hex(data)
    expect(digest).toBe(expected)
  })

  it('handles all-0xff byte array', async () => {
    const data = new Uint8Array(16).fill(0xff)
    const sha = new IncrementalSha1()
    await sha.update(data)
    const digest = await sha.digest()
    const expected = await sha1Hex(data)
    expect(digest).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// EncryptionKey - SSE-C key safety helpers (M11.5)
// ---------------------------------------------------------------------------

describe('EncryptionKey', () => {
  const rawKey = new Uint8Array(32).fill(0xaa)

  it('fromBytes computes base64 key and MD5 internally', async () => {
    const key = await EncryptionKey.fromBytes(rawKey)
    expect(key.mode).toBe('SSE-C')
    expect(key.algorithm).toBe('AES256')
    expect(key.customerKey).toBeTruthy()
    expect(key.customerKeyMd5).toBeTruthy()
    // 32 raw bytes -> 44 base64 chars (with padding)
    expect(key.customerKey.length).toBe(44)
  })

  it('fromBytes rejects keys that are not exactly 32 bytes', async () => {
    await expect(EncryptionKey.fromBytes(new Uint8Array(16))).rejects.toThrow(
      /must be exactly 32 bytes/,
    )
    await expect(EncryptionKey.fromBytes(new Uint8Array(33))).rejects.toThrow(
      /must be exactly 32 bytes/,
    )
  })

  it('fromBase64 accepts pre-computed strings', () => {
    const key = EncryptionKey.fromBase64('precomputed-key', 'precomputed-md5')
    expect(key.customerKey).toBe('precomputed-key')
    expect(key.customerKeyMd5).toBe('precomputed-md5')
  })

  it('toJSON redacts the customer key and MD5', async () => {
    const key = await EncryptionKey.fromBytes(rawKey)
    const json = JSON.stringify(key)
    expect(json).not.toContain(key.customerKey)
    expect(json).not.toContain(key.customerKeyMd5)
    expect(json).toContain('[redacted SSE-C key]')
  })

  it('toString does not leak the key', async () => {
    const key = await EncryptionKey.fromBytes(rawKey)
    const str = String(key)
    expect(str).not.toContain(key.customerKey)
    expect(str).toContain('[redacted')
  })

  // The `util.inspect` redaction assertion lives in
  // `encryption-key.node.test.ts` because `node:util` has no browser analogue.

  describe('MD5 computation against known vectors', () => {
    // These cross-runtime assertions exercise whichever MD5 backend the
    // current runtime selects (node:crypto in Node; the bundled pure-JS
    // fallback in browsers / edge). The expected base64 values were
    // computed with `openssl dgst -md5`.
    it('produces the correct base64 MD5 of a 32-byte all-0x61 key', async () => {
      const ek = await EncryptionKey.fromBytes(new Uint8Array(32).fill(0x61))
      expect(ek.customerKeyMd5).toBe('Xsqb0+sHwAbNQ65I395/0w==')
    })

    it('produces the correct base64 MD5 of a 32-byte all-0x00 key', async () => {
      const ek = await EncryptionKey.fromBytes(new Uint8Array(32))
      expect(ek.customerKeyMd5).toBe('cLyPS3KoaSFGi/joRB3OUQ==')
    })

    it('produces the correct base64 MD5 of a 32-byte all-0xff key', async () => {
      const ek = await EncryptionKey.fromBytes(new Uint8Array(32).fill(0xff))
      expect(ek.customerKeyMd5).toBe('DX3EJmSXEA5IMfWzG2snTw==')
    })
  })
})
