import { IncrementalSha1 } from '../streams/hash.ts'
import { normalizeSha1TimeoutMillis } from './sha1-options.ts'

const MAX_CONSECUTIVE_EMPTY_READ_CHUNKS = 1024

/**
 * Reads one non-empty stream chunk with an idle timeout and optional abort signal.
 * Empty chunks are not progress; too many consecutive empty chunks fail with the
 * same stalled-read diagnostic used for pending reads.
 *
 * @param reader - Locked reader to read from.
 * @param timeoutMillis - Idle timeout in milliseconds for this read.
 * @param stalledMessage - Error message used when the read makes no progress.
 * @param signal - Optional abort signal to observe while reading.
 *
 * @returns The next stream read result.
 *
 * @internal
 */
export async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMillis: number,
  stalledMessage: string,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let emptyChunks = 0
  while (true) {
    const result = await readRawStreamChunkWithTimeout(
      reader,
      timeoutMillis,
      stalledMessage,
      signal,
    )
    if (result.done || result.value.byteLength > 0) return result
    emptyChunks += 1
    if (emptyChunks > MAX_CONSECUTIVE_EMPTY_READ_CHUNKS) {
      throw new Error(stalledMessage)
    }
  }
}

async function readRawStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMillis: number,
  stalledMessage: string,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal?.throwIfAborted()

  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  const readPromise = reader.read()
  const timeoutPromise =
    timeoutMillis === Number.POSITIVE_INFINITY
      ? undefined
      : new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(stalledMessage))
          }, timeoutMillis)
        })
  const abortPromise =
    signal === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          const onAbort = () => reject(signal.reason ?? new Error('aborted'))
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        })

  try {
    if (timeoutPromise === undefined && abortPromise === undefined) return await readPromise
    const candidates = [readPromise]
    if (timeoutPromise !== undefined) candidates.push(timeoutPromise)
    if (abortPromise !== undefined) candidates.push(abortPromise)
    return await Promise.race(candidates)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    removeAbortListener?.()
    void readPromise.catch(() => {})
  }
}

/**
 * Hashes a B2 response body as SHA-1 with idle timeout, abort, and size checks.
 *
 * @param body - Response body stream to hash.
 * @param signal - Optional abort signal to observe while reading.
 * @param options - Optional timeout and byte-count limits.
 *
 * @returns The computed SHA-1 and number of bytes read.
 *
 * @internal
 */
export async function hashReadableStreamSha1(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options?: {
    readonly idleTimeoutMillis: number
    readonly maxBytes: number
    readonly expectedBytes: number
  },
): Promise<{ readonly contentSha1: string; readonly bytesRead: number }> {
  const hash = new IncrementalSha1()
  const reader = body.getReader()
  const idleTimeoutMillis = options?.idleTimeoutMillis ?? normalizeSha1TimeoutMillis(undefined)
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY
  const expectedBytes = options?.expectedBytes
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(
        reader,
        idleTimeoutMillis,
        `sha1 B2 read stalled for ${idleTimeoutMillis} ms`,
        signal,
      )
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) {
        throw new Error(`sha1 B2 read exceeded ${maxBytes} byte verification budget`)
      }
      await hash.update(value)
    }
    if (expectedBytes !== undefined && bytesRead !== expectedBytes) {
      throw new Error(`sha1 B2 read ended after ${bytesRead} bytes, expected ${expectedBytes}`)
    }
    return { contentSha1: await hash.digest(), bytesRead }
  } catch (err) {
    void reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
}

/**
 * Applies an absolute verification deadline while forwarding parent aborts.
 *
 * @param signal - Optional parent abort signal.
 * @param timeoutMillis - Absolute deadline in milliseconds.
 * @param run - Operation to run with the derived deadline signal.
 *
 * @returns The operation result.
 *
 * @internal
 */
export async function withSha1VerificationDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMillis: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromParent()
  signal?.addEventListener('abort', abortFromParent, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`sha1 B2 verification exceeded ${timeoutMillis} ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMillis)
  })
  const runPromise = run(controller.signal)
  try {
    return await Promise.race([runPromise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromParent)
    void runPromise.catch(() => {})
  }
}

/**
 * Bounds B2 SHA-1 verification downloads to the selected object's size and optional ceiling.
 *
 * @param contentLength - Selected B2 object byte length.
 * @param ceiling - Optional lower verification budget.
 *
 * @returns The byte budget to enforce.
 *
 * @internal
 */
export function normalizeSha1VerificationMaxBytes(
  contentLength: number,
  ceiling: number | undefined,
): number {
  const contentBudget = Math.max(0, Math.floor(contentLength))
  if (ceiling === undefined) return contentBudget
  if (!Number.isFinite(ceiling) || ceiling < 0) return contentBudget
  return Math.min(contentBudget, Math.floor(ceiling))
}
