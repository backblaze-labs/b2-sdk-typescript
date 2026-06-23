import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import type { ProgressListener } from '../streams/progress.ts'
import { ProgressTracker } from '../streams/progress.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { DEFAULT_CONTENT_TYPE, DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { toError } from '../util/to-error.ts'
import { createAbortScope } from './abort-scope.ts'
import {
  type CleanupFailureOptions,
  cancelLargeFileBestEffort,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  resolveLargeFileErrorAfterCleanup,
} from './cancel.ts'
import { Semaphore } from './concurrency.ts'
import { finishLargeFileWithAbortReconciliation } from './finish.ts'
import {
  resolveRetryResponseBodyFailures,
  type UploadRetryOptions,
  uploadPartWithFreshUrl,
} from './retry.ts'

/** Options for creating a streaming multipart upload sink. */
export interface CreateWriteStreamOptions extends UploadRetryOptions, CleanupFailureOptions {
  /** Target bucket for the upload. */
  readonly bucketId: BucketId
  /** Destination file name in the bucket. */
  readonly fileName: string
  /** MIME type. Defaults to `b2/x-auto`. */
  readonly contentType?: string
  /** Custom file info stored with the file. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption applied to each part. */
  readonly serverSideEncryption?: EncryptionSetting
  /**
   * Target part size in bytes. The stream buffers writes until this many bytes
   * are accumulated, then ships a part. Must be at least the account's
   * absolute minimum part size; the implementation will raise it if too small.
   */
  readonly partSize?: number
  /** Maximum number of parts uploaded in parallel. Defaults to 4. */
  readonly concurrency?: number
  /** Callback invoked with upload progress events. `totalBytes` is `null` (size unknown). */
  readonly onProgress?: ProgressListener
  /** Aborts the upload and cancels the unfinished large file. */
  readonly signal?: AbortSignal
}

/**
 * Handle returned by `B2Object.createWriteStream`: the Web `WritableStream` to
 * pipe data into, plus a promise that resolves with the finished
 * {@link FileVersion} once the stream is closed and all parts have been
 * uploaded.
 */
export interface UploadWriteHandle {
  /** Web `WritableStream` sink to pipe data into. */
  readonly writable: WritableStream<Uint8Array>
  /** Resolves with the finalized file version when the stream closes successfully. */
  readonly done: Promise<FileVersion>
}

/**
 * Creates a {@link WritableStream} that streams data into a B2 multipart upload.
 *
 * Buffers incoming chunks until `partSize` bytes are accumulated, ships each
 * complete part through the standard multipart engine, and finalizes the file
 * once the stream is closed. Honours backpressure via the queue's bounded
 * concurrency. Streaming uploads do not support resume because the total size
 * and per-part hashes aren't known in advance; use {@link uploadLargeFile} with
 * a buffered source when resume is required.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state (tokens, URLs, part URL pool).
 * @param options - Streaming upload parameters.
 *
 * @returns A {@link UploadWriteHandle} with the writable sink and a completion promise.
 */
export function createWriteStream(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: CreateWriteStreamOptions,
): UploadWriteHandle {
  const minPartSize = accountInfo.getAbsoluteMinimumPartSize()
  const recommendedPartSize = accountInfo.getRecommendedPartSize()
  const partSize = Math.max(options.partSize ?? recommendedPartSize, minPartSize)
  const concurrency = options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY
  const tracker = new ProgressTracker(options.onProgress, null, null)
  const sem = new Semaphore(concurrency)
  const abortScope = createAbortScope(options.signal)

  let largeFileId: LargeFileId | null = null
  let startPromise: Promise<LargeFileId> | null = null
  let cancelAfterStartScheduled = false
  let nextPartNumber = 1
  let pendingBytes = 0
  const pending: Uint8Array[] = []
  const partSha1s: string[] = []
  const inflight: Promise<void>[] = []
  let errored: Error | null = null

  // ES2024 `Promise.withResolvers()` exposes the resolve/reject pair as
  // properties of the returned object, avoiding the `let resolve!:` /
  // `let reject!:` non-null-assertion pattern needed before this API
  // existed. Available in Node 22 (our minimum), Bun, Deno, modern
  // browsers, and Cloudflare Workers.
  const {
    promise: done,
    resolve: resolveDone,
    reject: rejectDone,
  } = Promise.withResolvers<FileVersion>()
  // Attach a no-op rejection handler so a `done` that rejects before the
  // caller observes it never surfaces as a process-level unhandled rejection.
  // The error is not swallowed: `close()`/`abort()` also reject the writable
  // (so `pipeTo`/`getWriter().close()` throw), and any later `await done` /
  // `done.then(onRejected)` the caller attaches still sees the rejection —
  // extra handlers on the same promise all fire. Mirrors the
  // `task.catch(() => {})` pattern used for inflight part uploads below, and
  // keeps the engine well-behaved under Bun and Node's strict
  // unhandled-rejection mode.
  done.catch(() => {})

  function ensureStarted(): Promise<LargeFileId> {
    if (largeFileId !== null) return Promise.resolve(largeFileId)
    if (startPromise !== null) return startPromise
    startPromise = (async () => {
      const resp = await raw.startLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        {
          bucketId: options.bucketId,
          fileName: options.fileName,
          contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
          fileInfo: options.fileInfo ?? {},
          ...(options.serverSideEncryption !== undefined
            ? { serverSideEncryption: options.serverSideEncryption }
            : {}),
        },
        { signal: abortScope.signal },
      )
      largeFileId = resp.fileId
      if (abortScope.signal.aborted) {
        scheduleCancelLargeFileAfterStart(Promise.resolve(largeFileId))
      }
      return largeFileId
    })()
    return startPromise
  }

  async function shipPart(data: Uint8Array, partNumber: number): Promise<void> {
    if (errored !== null) throw errored
    abortScope.signal.throwIfAborted()
    const fileId = await ensureStarted()
    if (errored !== null) throw errored
    abortScope.signal.throwIfAborted()

    const sha1 = new IncrementalSha1()
    await sha1.update(data)
    const sha1Hex = await sha1.digest()
    abortScope.signal.throwIfAborted()

    const result = await uploadPartWithFreshUrl(raw, accountInfo, fileId, {
      fileName: options.fileName,
      partNumber,
      data: data as BodyInit,
      contentLength: data.byteLength,
      contentSha1: sha1Hex,
      retry: options.retry,
      signal: abortScope.signal,
      onUploadRetry: options.onUploadRetry,
      retryResponseBodyFailures: resolveRetryResponseBodyFailures(
        options.retryResponseBodyFailures,
        'multipart',
      ),
      ...(options.serverSideEncryption !== undefined
        ? { serverSideEncryption: options.serverSideEncryption }
        : {}),
    })
    partSha1s[partNumber - 1] = result.contentSha1
    tracker.addBytes(data.byteLength)
    tracker.completePart()
  }

  function markErrored(err: unknown): Error {
    const error = toError(err)
    errored = error
    abortScope.abort(error)
    return error
  }

  function scheduleCancelLargeFileAfterStart(started: Promise<LargeFileId>): void {
    if (cancelAfterStartScheduled) return
    cancelAfterStartScheduled = true
    void started
      .then((fileId) =>
        cancelLargeFileBestEffort(
          raw,
          accountInfo,
          fileId,
          cleanupWriteStreamOptions(options),
        ),
      )
      .catch(() => {
        // If start failed, no file ID is available to cancel.
      })
  }

  async function settleInflightForClose(): Promise<PromiseSettledResult<void>[]> {
    const settled = Promise.allSettled(inflight)
    if (startPromise === null || largeFileId !== null) return await settled

    const abortWaiter = waitForAbort(abortScope.signal)
    try {
      const first = await Promise.race([
        settled.then(() => 'settled' as const),
        startPromise.then(
          () => 'start-settled' as const,
          () => 'start-settled' as const,
        ),
        abortWaiter.promise.then(() => 'aborted' as const),
      ])
      if (first === 'aborted' && largeFileId === null) {
        throw abortReason(abortScope.signal)
      }
      return await settled
    } finally {
      abortWaiter.dispose()
    }
  }

  function startPartWithAcquiredSlot(data: Uint8Array, partNumber: number): void {
    const task = (async () => {
      try {
        await shipPart(data, partNumber)
      } catch (err) {
        markErrored(err)
        throw err
      } finally {
        sem.release()
      }
    })()
    inflight.push(task)
    // Swallow rejection here; we check `errored` later.
    task.catch(() => {})
  }

  async function acquirePartSlot(): Promise<void> {
    await sem.acquire()
    if (errored !== null) {
      sem.release()
      throw errored
    }
    try {
      abortScope.signal.throwIfAborted()
    } catch (err) {
      sem.release()
      throw err
    }
  }

  async function waitForInflightPartsToSettle(
    timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  ): Promise<void> {
    if (inflight.length === 0) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.allSettled(inflight).then(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, timeoutMs)
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async function dispatchPart(): Promise<void> {
    if (pending.length === 0) return
    await acquirePartSlot()
    let data: Uint8Array
    if (pending.length === 1) {
      const head = pending[0]
      if (!head) {
        sem.release()
        return
      }
      data = head
    } else {
      const total = pending.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      data = new Uint8Array(total)
      let offset = 0
      for (const chunk of pending) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
    }
    pending.length = 0
    pendingBytes = 0
    const partNumber = nextPartNumber++
    startPartWithAcquiredSlot(data, partNumber)
  }

  const writable = new WritableStream<Uint8Array>({
    async write(chunk: Uint8Array): Promise<void> {
      if (errored) throw errored
      abortScope.signal.throwIfAborted()
      if (chunk.byteLength === 0) return

      pending.push(chunk)
      pendingBytes += chunk.byteLength
      while (pendingBytes >= partSize) {
        await acquirePartSlot()
        if (errored) {
          sem.release()
          throw errored
        }
        // Pull exactly partSize bytes off the front
        const carved = carveExact(pending, partSize)
        const partNumber = nextPartNumber++
        pendingBytes -= partSize
        startPartWithAcquiredSlot(carved, partNumber)
      }
    },

    async close(): Promise<void> {
      try {
        if (errored) throw errored
        abortScope.signal.throwIfAborted()

        // Ship any remaining bytes as the last part. If the total fit in one
        // single buffered batch (no parts shipped yet), we have to use the
        // multipart path anyway since we already called startLargeFile lazily.
        if (pendingBytes > 0) {
          await dispatchPart()
        }

        const settled = await settleInflightForClose()
        const rejected = settled.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        )
        if (rejected !== undefined && errored === null) {
          markErrored(rejected.reason)
        }
        if (errored) throw errored

        if (largeFileId === null) {
          // Stream closed before any data was written. Start an empty large
          // file? B2 requires at least 2 parts. Reject — callers shouldn't
          // close an empty stream.
          throw new Error('createWriteStream closed without any data written.')
        }

        const result = await finishLargeFileWithAbortReconciliation(raw, accountInfo, {
          fileId: largeFileId,
          bucketId: options.bucketId,
          fileName: options.fileName,
          partSha1s,
          signal: abortScope.signal,
        })
        abortScope.dispose()
        resolveDone(result)
      } catch (err) {
        const closeError = toError(err)
        if (errored === null) errored = closeError
        abortScope.abort(errored)
        const observedError = errored
        const fileIdToCancel = largeFileId
        if (fileIdToCancel === null && startPromise !== null) {
          // Mirror writer.abort(): close() must not wait for non-abortable
          // b2_start_large_file. If a file ID arrives later, cancel it in the
          // background.
          scheduleCancelLargeFileAfterStart(startPromise)
          abortScope.dispose()
          rejectDone(observedError)
          throw observedError
        }
        await Promise.allSettled(inflight)
        // Capture into a const so the cancel closure sees a non-null
        // `fileId`; closures don't observe the outer `!== null` narrowing
        // because the variable is mutable across the lambda boundary.
        let finalError: unknown = observedError
        if (fileIdToCancel !== null) {
          finalError = await resolveLargeFileErrorAfterCleanup(observedError, raw, accountInfo, {
            fileId: fileIdToCancel,
            bucketId: options.bucketId,
            fileName: options.fileName,
            signal: options.signal,
            onCleanupFailure: options.onCleanupFailure,
          })
        }
        abortScope.dispose()
        rejectDone(finalError)
        throw finalError
      }
    },

    async abort(reason: unknown): Promise<void> {
      const abortError = markErrored(reason)
      pending.length = 0
      pendingBytes = 0
      const fileIdToCancel = largeFileId
      if (fileIdToCancel === null && startPromise !== null) {
        // Do not await an in-flight start request here. A stalled
        // b2_start_large_file must not make writer.abort() hang; if it later
        // returns a file ID, cancel it best-effort in the background.
        scheduleCancelLargeFileAfterStart(startPromise)
      }
      if (fileIdToCancel !== null) {
        await waitForInflightPartsToSettle()
        await cancelLargeFileBestEffort(
          raw,
          accountInfo,
          fileIdToCancel,
          cleanupWriteStreamOptions(options),
        )
      }
      abortScope.dispose()
      rejectDone(abortError)
    },
  })

  return { writable, done }
}

function cleanupWriteStreamOptions(options: CreateWriteStreamOptions): {
  readonly signal?: AbortSignal
} & CleanupFailureOptions {
  return {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onCleanupFailure !== undefined
      ? { onCleanupFailure: options.onCleanupFailure }
      : {}),
  }
}

/**
 * Removes exactly `size` bytes from the front of `chunks` (mutates) and returns
 * them as a contiguous Uint8Array. Any trailing remainder of the last chunk
 * stays at the front of `chunks` for the next part.
 *
 * @param chunks - Queue of pending chunks. Modified in place.
 * @param size - Number of bytes to carve off the front.
 *
 * @returns A new Uint8Array containing exactly `size` bytes.
 */
function carveExact(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let written = 0
  while (written < size && chunks.length > 0) {
    const head = chunks[0]
    if (!head) break
    const need = size - written
    if (head.byteLength <= need) {
      out.set(head, written)
      written += head.byteLength
      chunks.shift()
    } else {
      out.set(head.subarray(0, need), written)
      chunks[0] = head.subarray(need)
      written += need
    }
  }
  return out
}

function waitForAbort(signal: AbortSignal): {
  readonly promise: Promise<unknown>
  dispose(): void
} {
  if (signal.aborted) {
    return {
      promise: Promise.resolve(abortReason(signal)),
      dispose() {},
    }
  }

  let onAbort: (() => void) | undefined
  const promise = new Promise<unknown>((resolve) => {
    onAbort = () => resolve(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  return {
    promise,
    dispose() {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    },
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}
