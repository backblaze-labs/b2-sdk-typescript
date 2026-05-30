import type { AccountInfo } from '../auth/account-info.ts'
import { B2Error, classifyError, NetworkError } from '../errors/index.ts'
import { computeBackoff, DEFAULT_RETRY_OPTIONS, type RetryOptions, sleep } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import { collectStream } from '../streams/collect.ts'
import type { B2ErrorResponse } from '../types/errors.ts'
import type { FileId } from '../types/ids.ts'
import { DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { byteRangeHeader, planRanges } from '../util/plan-ranges.ts'
import { utf8Decoder } from '../util/text-codec.ts'

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
  /**
   * Extra retry attempts per range on transient failures. Defaults to 0 because
   * `B2Client` already applies `RetryTransport`; set this only when supplying a
   * raw client that does not already retry transport failures.
   */
  readonly maxRetries?: number
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
}

/**
 * Creates a readable stream that downloads a file using parallel byte-range requests.
 *
 * The file is split into fixed-size ranges fetched in a **sliding
 * window** keyed off the consumer's read pace. The window size is
 * `concurrency * 2`: up to `concurrency` ranges are in flight at once,
 * plus up to `concurrency` completed-but-not-yet-emitted ranges buffered
 * ahead of the read head. New fetches kick off only when the consumer
 * reads a chunk, so a slow downstream pipe (e.g. a saturated network
 * sink or a `pipeTo` consumer that drains slowly) backpressures into
 * the SDK and bounds peak memory to `(concurrency * 2) * rangeSize`.
 *
 * The previous eager implementation scheduled every range into
 * `Promise.all` up front; a slow head-of-line range could hold the
 * entire file in memory while later ranges finished and waited.
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
  // The high-level B2Client already wraps the raw transport in RetryTransport.
  // Keep the parallel-download outer retry disabled by default so each range
  // has one retry budget unless callers explicitly opt into an extra raw-client
  // retry layer.
  const retryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    maxRetries: options.maxRetries ?? 0,
  }
  const abort = options.signal

  const ranges = planRanges(totalSize, rangeSize)

  // `inflight` holds currently-fetching range promises; `buffer` holds
  // completed ranges waiting for their slot in the emit order. Total
  // scheduled-but-not-emitted = inflight.size + buffer.size is capped
  // at `windowSize`, so peak memory is bounded regardless of any
  // single range's latency.
  const windowSize = concurrency * 2
  const inflight = new Map<number, Promise<void>>()
  const buffer = new Map<number, Uint8Array>()
  let nextToSchedule = 0
  let nextToEmit = 0
  let firstError: unknown = null

  function scheduleNext(): void {
    while (
      firstError === null &&
      // Honour abort here so a completed range that triggers a top-up
      // doesn't queue one final fetch after the caller aborted. Without
      // this gate, one extra range request fires post-abort before the
      // `pull()` loop notices.
      abort?.aborted !== true &&
      nextToSchedule < ranges.length &&
      inflight.size + buffer.size < windowSize
    ) {
      const range = ranges[nextToSchedule]
      if (range === undefined) break
      const idx = nextToSchedule
      nextToSchedule++
      const task = (async () => {
        try {
          const data = await fetchRangeWithRetry(
            raw,
            accountInfo,
            options.fileId,
            range.start,
            range.end,
            totalSize,
            retryOptions,
            abort,
          )
          buffer.set(idx, data)
        } catch (err) {
          if (firstError === null) firstError = err
        } finally {
          inflight.delete(idx)
        }
      })()
      inflight.set(idx, task)
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Pre-warm: kick off the initial window so the first `pull` has
      // something to await. An already-aborted signal surfaces as a
      // stream error rather than a synchronous throw, matching the
      // contract callers had with the previous eager implementation.
      try {
        abort?.throwIfAborted()
        scheduleNext()
      } catch (err) {
        controller.error(err)
      }
    },
    async pull(controller) {
      try {
        // Wait until the next in-order chunk is available.
        while (!buffer.has(nextToEmit)) {
          abort?.throwIfAborted()
          if (firstError !== null) throw firstError
          /* v8 ignore start -- defensive close: every code path that
             populates `nextToEmit < ranges.length` also schedules into
             `inflight`. The pre-warm in `start()` plus `scheduleNext()`
             after each enqueue guarantee that whenever there are
             pending ranges, at least one is in flight. This guard
             exists only so a future refactor can't accidentally stall
             the stream by leaving both maps empty mid-stream. */
          if (inflight.size === 0) {
            controller.close()
            return
          }
          /* v8 ignore stop */
          await Promise.race(inflight.values())
        }

        const data = buffer.get(nextToEmit)
        if (data !== undefined) {
          buffer.delete(nextToEmit)
          nextToEmit++
          controller.enqueue(data)
        }

        // Top up the window now that we freed a slot by emitting.
        scheduleNext()

        if (
          nextToEmit >= ranges.length &&
          buffer.size === 0 &&
          inflight.size === 0 &&
          firstError === null
        ) {
          controller.close()
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      // Abort propagation handles in-flight requests; just drop buffered
      // data so it can be GC'd promptly.
      buffer.clear()
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
 * @param totalSize - Expected complete file size.
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
  totalSize: number,
  retryOptions: RetryOptions,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    if (attempt > 0) {
      const retryAfter =
        lastError instanceof B2Error && lastError.retryAfter !== undefined
          ? lastError.retryAfter
          : undefined
      const delay = computeBackoff(attempt - 1, retryOptions, retryAfter)
      await sleep(delay, signal)
    }
    try {
      signal?.throwIfAborted()
      const resp = await raw.downloadFileById(
        accountInfo.getDownloadUrl(),
        accountInfo.getAuthToken(),
        fileId,
        {
          range: byteRangeHeader(start, end),
          ...(signal !== undefined ? { signal } : {}),
        },
      )
      if (resp.status < 200 || resp.status >= 300) {
        throw await classifyDownloadResponseError(resp)
      }
      if (!resp.body) throw new Error('Download chunk has no body')
      const data = await collectStream(resp.body)
      validateRangeResponse(resp, start, end, totalSize, data.byteLength)
      return data
    } catch (err) {
      lastError = err
      // Honour AbortSignal cancellation: don't retry past an abort.
      if (signal?.aborted) throw err
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (!isRetryableRangeError(err) || attempt === retryOptions.maxRetries) {
        throw err
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Range download failed after retries')
}

class RangeValidationError extends Error {
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'RangeValidationError'
  }
}

function validateRangeResponse(
  response: { headers: Headers; status: number },
  start: number,
  end: number,
  totalSize: number,
  byteLength: number,
): void {
  const expectedLength = end - start + 1
  if (response.status !== 206) {
    throw new RangeValidationError(
      `Expected HTTP 206 Partial Content for range ${start}-${end}, got ${response.status}`,
    )
  }

  const contentRange = response.headers.get('Content-Range')
  if (contentRange === null) {
    throw new RangeValidationError(`Missing Content-Range for range ${start}-${end}`)
  }

  const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/)
  if (match === null) {
    throw new RangeValidationError(
      `Invalid Content-Range for range ${start}-${end}: ${contentRange}`,
    )
  }

  const actualStart = Number.parseInt(match[1] ?? '', 10)
  const actualEnd = Number.parseInt(match[2] ?? '', 10)
  const actualTotal = match[3] ?? ''
  if (actualStart !== start || actualEnd !== end) {
    throw new RangeValidationError(
      `Content-Range ${contentRange} does not match requested range ${start}-${end}`,
    )
  }

  if (actualTotal === '*') {
    throw new RangeValidationError(`Content-Range ${contentRange} does not include total size`)
  }

  const parsedTotal = Number.parseInt(actualTotal, 10)
  if (parsedTotal !== totalSize) {
    throw new RangeValidationError(
      `Content-Range ${contentRange} does not match expected total size ${totalSize}`,
    )
  }

  if (byteLength !== expectedLength) {
    throw new RangeValidationError(
      `Expected ${expectedLength} bytes for range ${start}-${end}, got ${byteLength}`,
    )
  }
}

async function classifyDownloadResponseError(response: {
  headers: Headers
  status: number
  body: ReadableStream<Uint8Array> | null
}): Promise<B2Error> {
  let errorBody: B2ErrorResponse = {
    status: response.status,
    code: 'internal_error',
    message: `HTTP ${response.status}`,
  }

  if (response.body !== null) {
    const bytes = await collectStream(response.body)
    try {
      const parsed = JSON.parse(utf8Decoder.decode(bytes)) as Partial<B2ErrorResponse>
      errorBody = {
        status: response.status,
        code: parsed.code ?? 'internal_error',
        message: parsed.message ?? `HTTP ${response.status}`,
      }
    } catch {
      // Keep the synthetic errorBody above when the response body is not JSON.
    }
  }

  const retryAfterHeader = response.headers.get('Retry-After')
  const retryAfter = retryAfterHeader !== null ? Number.parseInt(retryAfterHeader, 10) : undefined
  const requestId = response.headers.get('X-Bz-Request-Id') ?? undefined

  return classifyError(errorBody, {
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  })
}

function isRetryableRangeError(err: unknown): boolean {
  if (err instanceof B2Error || err instanceof NetworkError) return err.retryable
  if (hasRetryableFlag(err)) return err.retryable
  // Bare FetchTransport surfaces network failures as TypeError. Validation
  // failures use RangeValidationError above, so they never land here.
  return err instanceof TypeError
}

function hasRetryableFlag(err: unknown): err is { retryable: boolean } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'retryable' in err &&
    typeof (err as { retryable?: unknown }).retryable === 'boolean'
  )
}
