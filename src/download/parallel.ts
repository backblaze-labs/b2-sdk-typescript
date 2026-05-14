import type { AccountInfo } from '../auth/account-info.ts'
import { DEFAULT_RETRY_OPTIONS, computeBackoff, sleep } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import type { FileId } from '../types/ids.ts'
import { Semaphore } from '../upload/concurrency.ts'
import { DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'

/** Options for downloading a file using concurrent byte-range requests. */
export interface ParallelDownloadOptions {
  /** ID of the file to download. */
  readonly fileId: FileId
  /** Total file size in bytes (must be known in advance). */
  readonly totalSize: number
  /** Size of each ranged chunk in bytes. Defaults to 10 MB. */
  readonly rangeSize?: number
  /** Maximum number of chunks fetched in parallel. Defaults to 4. */
  readonly concurrency?: number
  /** Maximum retry attempts per range on transient failures. Defaults to 5. */
  readonly maxRetries?: number
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
}

/**
 * Creates a readable stream that downloads a file using parallel byte-range requests.
 *
 * The file is split into fixed-size ranges fetched concurrently, then chunks
 * are emitted in order. This approach saturates bandwidth more effectively than
 * a single sequential download for large files. For small files, a single
 * request via {@link downloadById} or {@link downloadByName} is simpler.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - Parallel download parameters (file ID, size, concurrency).
 *
 * @returns A `ReadableStream` that yields file bytes in order.
 */
export function createParallelDownloadStream(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: ParallelDownloadOptions,
): ReadableStream<Uint8Array> {
  const rangeSize = options.rangeSize ?? 10 * 1024 * 1024
  const concurrency = options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY
  const totalSize = options.totalSize
  const retryOptions = { ...DEFAULT_RETRY_OPTIONS, maxRetries: options.maxRetries ?? 5 }

  const ranges: { start: number; end: number; index: number }[] = []
  let offset = 0
  let index = 0
  while (offset < totalSize) {
    const end = Math.min(offset + rangeSize - 1, totalSize - 1)
    ranges.push({ start: offset, end, index })
    offset = end + 1
    index++
  }

  const chunks: (Uint8Array | null)[] = new Array(ranges.length).fill(null)
  let nextToEmit = 0
  let fetchStarted = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (fetchStarted) return
      fetchStarted = true

      const sem = new Semaphore(concurrency)
      const abort = options.signal

      try {
        const tasks = ranges.map(async (range) => {
          await sem.acquire()
          try {
            abort?.throwIfAborted()

            const data = await fetchRangeWithRetry(
              raw,
              accountInfo,
              options.fileId,
              range.start,
              range.end,
              retryOptions,
              abort,
            )
            chunks[range.index] = data

            for (
              let chunk = chunks[nextToEmit];
              nextToEmit < chunks.length && chunk != null;
              chunk = chunks[++nextToEmit]
            ) {
              controller.enqueue(chunk)
              chunks[nextToEmit] = null
            }
          } finally {
            sem.release()
          }
        })

        await Promise.all(tasks)

        for (
          let chunk = chunks[nextToEmit];
          nextToEmit < chunks.length && chunk != null;
          chunk = chunks[++nextToEmit]
        ) {
          controller.enqueue(chunk)
          chunks[nextToEmit] = null
        }

        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Fetches a single byte range with bounded retry on transient failures.
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - ID of the file being downloaded.
 * @param start - Inclusive byte offset where the range begins.
 * @param end - Inclusive byte offset where the range ends.
 * @param retryOptions - Retry settings controlling attempts and backoff.
 * @param signal - Optional abort signal that cancels the range and any pending retry.
 *
 * @returns The range's bytes, or throws after exhausting all retry attempts.
 */
async function fetchRangeWithRetry(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: FileId,
  start: number,
  end: number,
  retryOptions: typeof DEFAULT_RETRY_OPTIONS,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = computeBackoff(attempt - 1, retryOptions)
      await sleep(delay, signal)
    }
    try {
      signal?.throwIfAborted()
      const resp = await raw.downloadFileById(
        accountInfo.getDownloadUrl(),
        accountInfo.getAuthToken(),
        fileId as string,
        {
          range: `bytes=${start}-${end}`,
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      if (!resp.body) throw new Error('Download chunk has no body')
      return new Uint8Array(await readAll(resp.body))
    } catch (err) {
      lastError = err
      // Honour AbortSignal cancellation: don't retry past an abort.
      if (signal?.aborted) throw err
      if (err instanceof DOMException && err.name === 'AbortError') throw err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Range download failed after retries')
}

/**
 * Reads an entire readable stream into a single Uint8Array.
 * @param stream - The readable stream to consume.
 *
 * @returns The concatenated bytes from the stream.
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}
