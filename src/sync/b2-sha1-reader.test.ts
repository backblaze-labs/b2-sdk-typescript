import { describe, expect, it } from 'vitest'
import { sha1Hex } from '../streams/hash.ts'
import {
  hashReadableStreamSha1,
  normalizeSha1VerificationMaxBytes,
  readStreamChunkWithTimeout,
  withSha1VerificationDeadline,
} from './b2-sha1-reader.ts'

const textEncoder = new TextEncoder()
const globals = globalThis as Record<string, unknown>
const isBun = typeof globals['Bun'] !== 'undefined'

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('readStreamChunkWithTimeout', () => {
  it('returns stream chunks without scheduling a timeout when the timeout is infinite', async () => {
    const reader = streamFromChunks([textEncoder.encode('abc')]).getReader()
    try {
      const result = await readStreamChunkWithTimeout(reader, Number.POSITIVE_INFINITY, 'stalled')
      expect(result).toMatchObject({ done: false, value: textEncoder.encode('abc') })
    } finally {
      reader.releaseLock()
    }
  })

  it('returns stream chunks before the idle timeout', async () => {
    const reader = streamFromChunks([textEncoder.encode('abc')]).getReader()
    try {
      const result = await readStreamChunkWithTimeout(reader, 1000, 'stalled')
      expect(result).toMatchObject({ done: false, value: textEncoder.encode('abc') })
    } finally {
      reader.releaseLock()
    }
  })

  it('rejects reads that make no progress before the timeout', async () => {
    const reader = new ReadableStream<Uint8Array>().getReader()
    const promise = readStreamChunkWithTimeout(reader, 1, 'stalled')
    const rejection = expect(promise).rejects.toThrow('stalled')

    await rejection
    await reader.cancel()
    reader.releaseLock()
  })

  it.skipIf(isBun)('rejects when the abort signal fires during a pending read', async () => {
    const controller = new AbortController()
    const reader = new ReadableStream<Uint8Array>().getReader()
    const promise = readStreamChunkWithTimeout(reader, 1000, 'stalled', controller.signal)
    const rejection = expect(promise).rejects.toThrow('cancelled')

    controller.abort(new Error('cancelled'))

    await rejection
    await reader.cancel()
    reader.releaseLock()
  })
})

describe('hashReadableStreamSha1', () => {
  it('hashes chunks and reports bytes read', async () => {
    const chunks = [textEncoder.encode('ab'), textEncoder.encode('c')]

    const result = await hashReadableStreamSha1(streamFromChunks(chunks), undefined, {
      idleTimeoutMillis: 1000,
      maxBytes: 3,
      expectedBytes: 3,
    })

    expect(result).toEqual({
      contentSha1: await sha1Hex(textEncoder.encode('abc')),
      bytesRead: 3,
    })
  })

  it('rejects streams that exceed the byte ceiling', async () => {
    await expect(
      hashReadableStreamSha1(streamFromChunks([textEncoder.encode('abcd')]), undefined, {
        idleTimeoutMillis: 1000,
        maxBytes: 3,
        expectedBytes: 4,
      }),
    ).rejects.toThrow('exceeded 3 byte verification budget')
  })

  it('rejects streams that end before the expected byte count', async () => {
    await expect(
      hashReadableStreamSha1(streamFromChunks([textEncoder.encode('abc')]), undefined, {
        idleTimeoutMillis: 1000,
        maxBytes: 4,
        expectedBytes: 4,
      }),
    ).rejects.toThrow('ended after 3 bytes, expected 4')
  })
})

describe('withSha1VerificationDeadline', () => {
  it('returns the operation result before the deadline', async () => {
    await expect(
      withSha1VerificationDeadline(undefined, 1000, async (signal) => {
        expect(signal.aborted).toBe(false)
        return 'ok'
      }),
    ).resolves.toBe('ok')
  })

  it('rejects and aborts the derived signal when the deadline expires', async () => {
    let derivedSignal: AbortSignal | undefined
    const promise = withSha1VerificationDeadline(undefined, 1, (signal) => {
      derivedSignal = signal
      return new Promise<string>(() => {})
    })
    const rejection = expect(promise).rejects.toThrow('sha1 B2 verification exceeded 1 ms')

    await rejection
    expect(derivedSignal?.aborted).toBe(true)
  })

  it('forwards an already-aborted parent signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('parent aborted'))

    await expect(
      withSha1VerificationDeadline(controller.signal, 1000, async (signal) => {
        signal.throwIfAborted()
        return 'unreachable'
      }),
    ).rejects.toThrow('parent aborted')
  })
})

describe('normalizeSha1VerificationMaxBytes', () => {
  it('uses the selected content length unless a smaller valid ceiling exists', () => {
    expect(normalizeSha1VerificationMaxBytes(10.9, undefined)).toBe(10)
    expect(normalizeSha1VerificationMaxBytes(10, 6.9)).toBe(6)
    expect(normalizeSha1VerificationMaxBytes(10, 20)).toBe(10)
    expect(normalizeSha1VerificationMaxBytes(10, Number.NaN)).toBe(10)
    expect(normalizeSha1VerificationMaxBytes(-1, 10)).toBe(0)
  })
})
