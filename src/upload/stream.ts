import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import type { ProgressListener } from '../streams/progress.ts'
import { ProgressTracker } from '../streams/progress.ts'
import { BufferSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { abortReason, raceWithAbort } from '../util/abort.ts'
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
import { assertPartLimit } from './part-limit.ts'
import {
  resolveRetryResponseBodyFailures,
  resolveRetryUploadConnectionFaults,
  type UploadRetryOptions,
  uploadPartWithFreshUrl,
} from './retry.ts'
import { uploadSmallFile } from './single.ts'

/** Options for creating a streaming upload sink. */
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
   * B2 upload timestamp override in milliseconds since epoch.
   * Sets the file version `uploadTimestamp`; distinct from `src_last_modified_millis` metadata.
   * Requires B2 account enablement for Custom Upload Timestamp.
   */
  readonly customUploadTimestamp?: number
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
  /**
   * Minimum milliseconds between byte-only progress callbacks. Defaults to
   * the SDK's 100 ms progress interval; set to 0 for per-chunk callbacks.
   * Part-completion progress callbacks are always emitted immediately.
   */
  readonly progressIntervalMillis?: number
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
 * Creates a {@link WritableStream} that uploads data into B2.
 *
 * Buffers incoming chunks until `partSize` bytes are accumulated, ships each
 * complete part through the standard multipart engine, and finalizes the file
 * once the stream is closed. Streams of one part or less finish through a
 * single-request file upload; larger streams finish as multipart uploads.
 * At exactly one part, the provisional large file is cancelled and the retained
 * bytes are uploaded again through the single-request path.
 * Closing a stream without writing any data rejects.
 *
 * Honours backpressure via the queue's bounded concurrency. Streaming uploads
 * do not support resume because the total size and per-part hashes aren't known
 * in advance; use {@link uploadLargeFile} with a buffered source when resume is required.
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
  const tracker = new ProgressTracker(options.onProgress, null, null, {
    ...(options.progressIntervalMillis !== undefined
      ? { minIntervalMs: options.progressIntervalMillis }
      : {}),
  })
  const sem = new Semaphore(concurrency)
  const abortScope = createAbortScope(options.signal)

  let largeFileId: LargeFileId | null = null
  let startPromise: Promise<LargeFileId> | null = null
  let cancelAfterStartScheduled = false
  let cancelPromise: Promise<void> | null = null
  let failureCleanup: Promise<unknown> | null = null
  let streamController: WritableStreamDefaultController
  let nextPartNumber = 1
  let pendingBytes = 0
  const pending: Uint8Array[] = []
  const partSha1s: string[] = []
  const inflight: Promise<void>[] = []
  let errored: Error | null = null
  // Keep at most one part for the single-request fallback at close().
  let firstPartData: Uint8Array | null = null

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
    if (startPromise === null) {
      const rawStart = raw.startLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        {
          bucketId: options.bucketId,
          fileName: options.fileName,
          contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
          fileInfo: options.fileInfo ?? {},
          ...(options.customUploadTimestamp !== undefined
            ? { customUploadTimestamp: String(options.customUploadTimestamp) }
            : {}),
          ...(options.serverSideEncryption !== undefined
            ? { serverSideEncryption: options.serverSideEncryption }
            : {}),
        },
        {
          signal: abortScope.signal,
          ...(options.retry !== undefined ? { retry: options.retry } : {}),
        },
      )
      startPromise = rawStart.then((resp) => {
        largeFileId = resp.fileId
        if (abortScope.signal.aborted || errored !== null) {
          cancelStartedLargeFile(largeFileId)
        }
        return largeFileId
      })
    }
    const started = startPromise
    return raceWithAbort(started, abortScope.signal).catch((err) => {
      if (abortScope.signal.aborted) scheduleCancelLargeFileAfterStart(started)
      throw err
    })
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
      ),
      retryUploadConnectionFaults: resolveRetryUploadConnectionFaults(
        options.retryUploadConnectionFaults,
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
    errored ??= toError(err)
    tracker.dispose()
    abortScope.abort(errored)
    return errored
  }

  function cancelStartedLargeFile(fileId: LargeFileId): Promise<void> {
    if (cancelAfterStartScheduled) return cancelPromise ?? Promise.resolve()
    cancelAfterStartScheduled = true
    cancelPromise = cancelLargeFileBestEffort(
      raw,
      accountInfo,
      fileId,
      cleanupWriteStreamOptions(options),
    )
    return cancelPromise
  }

  function scheduleCancelLargeFileAfterStart(started: Promise<LargeFileId>): void {
    void started
      .then((fileId) => cancelStartedLargeFile(fileId))
      .catch(() => {
        // If start failed, no file ID is available to cancel.
      })
  }

  async function failUpload(err: unknown): Promise<unknown> {
    const observedError = markErrored(err)
    pending.length = 0
    pendingBytes = 0
    firstPartData = null
    failureCleanup ??= (async () => {
      const fileId = largeFileId
      if (fileId === null) {
        if (startPromise !== null) scheduleCancelLargeFileAfterStart(startPromise)
        return observedError
      }
      await waitForInflightPartsToSettle()
      if (cancelAfterStartScheduled) {
        await cancelPromise
        return observedError
      }
      cancelAfterStartScheduled = true
      return resolveLargeFileErrorAfterCleanup(observedError, raw, accountInfo, {
        fileId,
        bucketId: options.bucketId,
        fileName: options.fileName,
        signal: options.signal,
        onCleanupFailure: options.onCleanupFailure,
      })
    })()
    const finalError = await failureCleanup
    abortScope.dispose()
    rejectDone(finalError)
    return finalError
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
    firstPartData = partNumber === 1 ? data : null
    const task = (async () => {
      try {
        await shipPart(data, partNumber)
      } catch (err) {
        // Cleanup waits for all part tasks, including this one: do not await it here.
        void failUpload(err)
        streamController.error(errored)
        throw errored
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
    /* v8 ignore next -- only called after a large file exists, which requires at least one part */
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
      /* v8 ignore next -- setTimeout is assigned synchronously when the race promise is built */
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async function dispatchPart(): Promise<void> {
    /* v8 ignore next -- callers guard on pendingBytes before dispatching the final part */
    if (pending.length === 0) return
    await acquirePartSlot()
    let data: Uint8Array
    if (pending.length === 1) {
      const head = pending[0]
      /* v8 ignore next -- pending is never sparse; this narrows noUncheckedIndexedAccess */
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
    start(controller): void {
      streamController = controller
    },
    async write(chunk: Uint8Array): Promise<void> {
      if (errored) throw errored
      abortScope.signal.throwIfAborted()
      if (chunk.byteLength === 0) return

      try {
        assertPartLimit(
          nextPartNumber - 1 + Math.ceil((pendingBytes + chunk.byteLength) / partSize),
        )
      } catch (err) {
        throw await failUpload(err)
      }
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

        // B2 cannot finish a large file with only one part. Small buffered
        // streams and exact-one-part streams use the single-request path.
        const singleData =
          nextPartNumber === 1 && pendingBytes > 0
            ? carveExact(pending, pendingBytes)
            : nextPartNumber === 2 && pendingBytes === 0
              ? firstPartData
              : null
        if (singleData !== null) {
          await settleInflightForClose()
          if (errored) throw errored
          abortScope.signal.throwIfAborted()
          if (largeFileId !== null) await cancelStartedLargeFile(largeFileId)
          const result = await uploadSmallFile(raw, accountInfo, {
            bucketId: options.bucketId,
            fileName: options.fileName,
            contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
            fileInfo: options.fileInfo ?? {},
            ...(options.serverSideEncryption !== undefined
              ? { serverSideEncryption: options.serverSideEncryption }
              : {}),
            ...(options.customUploadTimestamp !== undefined
              ? { customUploadTimestamp: options.customUploadTimestamp }
              : {}),
            retry: options.retry,
            onUploadRetry: options.onUploadRetry,
            retryResponseBodyFailures: options.retryResponseBodyFailures,
            retryUploadConnectionFaults: options.retryUploadConnectionFaults,
            source: new BufferSource(singleData),
            signal: abortScope.signal,
          })
          if (nextPartNumber === 1) {
            tracker.addBytes(singleData.byteLength)
            tracker.completePart()
          }
          pending.length = 0
          pendingBytes = 0
          firstPartData = null
          tracker.dispose()
          abortScope.dispose()
          resolveDone(result)
          return
        }

        // Ship any remaining bytes as the final part of a multipart upload.
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
          ...(options.retry !== undefined ? { retry: options.retry } : {}),
        })
        tracker.dispose()
        abortScope.dispose()
        resolveDone(result)
      } catch (err) {
        throw await failUpload(err)
      }
    },

    async abort(reason: unknown): Promise<void> {
      await failUpload(reason)
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
    /* v8 ignore next -- chunks is never sparse; this narrows noUncheckedIndexedAccess */
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
  /* v8 ignore next -- callers check abort before entering the start/close wait race */
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
      /* v8 ignore next -- listener is assigned synchronously with promise construction */
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    },
  }
}
