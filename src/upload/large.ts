import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import type { ProgressListener } from '../streams/progress.ts'
import { ProgressTracker } from '../streams/progress.ts'
import { type ContentSource, readNextNonEmptyStreamChunk } from '../streams/source.ts'
import type { BucketRetentionPolicy } from '../types/bucket.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import { DEFAULT_CONTENT_TYPE, DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { planRanges, type RangePlan } from '../util/plan-ranges.ts'
import { createAbortScope, raceWithAbort, throwRejectedOrAbortReason } from './abort-scope.ts'
import {
  type CleanupFailureOptions,
  cancelLargeFileBestEffort,
  cleanupAfterLargeFileError,
} from './cancel.ts'
import { Semaphore } from './concurrency.ts'
import { finishLargeFileWithAbortReconciliation } from './finish.ts'
import {
  findResumeCandidate,
  type ResumeCandidateCriteria,
  type ResumeCandidateRejectedListener,
  ResumeFileIdMismatchError,
} from './resume.ts'
import {
  resolveRetryResponseBodyFailures,
  type UploadRetryOptions,
  uploadPartWithFreshUrl,
} from './retry.ts'

/** Event emitted when explicit resume skips a local part because B2 already has matching SHA-1 bytes. */
export interface ResumePartReusedEvent {
  /** File name being resumed. */
  readonly fileName: string
  /** Unfinished large-file ID that supplied the existing part. */
  readonly fileId: LargeFileId
  /** One-based part number reused from the unfinished large file. */
  readonly partNumber: number
  /** Number of bytes in the reused part. */
  readonly contentLength: number
  /** SHA-1 hex digest that matched the local part bytes. */
  readonly contentSha1: string
}

/** Callback invoked when explicit resume accepts a pre-existing server part. */
export type ResumePartReusedListener = (event: ResumePartReusedEvent) => void

const MAX_CONSECUTIVE_EMPTY_STREAM_CHUNKS = 1024

/** Options for uploading a large file via the multipart protocol. */
export interface UploadLargeFileOptions extends UploadRetryOptions, CleanupFailureOptions {
  /** Target bucket for the upload. */
  readonly bucketId: BucketId
  /** Full B2 file name including any path prefix. */
  readonly fileName: string
  /**
   * Content to upload. Sliceable sources ({@link BufferSource},
   * {@link BlobSource}, {@link FileSource}) use the parallel-parts path.
   * Non-sliceable streams and async iterables fall back to a sequential read
   * path — one part at a time, concurrency forced to 1 — so callers can stream
   * a multi-GB file without buffering the whole payload in memory. The
   * `resumeFileId` requires a sliceable source; deprecated `resume: true`
   * without an explicit file ID is ignored on forward-only sources.
   */
  readonly source: ContentSource
  /** MIME type. Defaults to `b2/x-auto` for server-side detection. */
  readonly contentType?: string
  /** Custom file info key/value pairs stored with the file. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption settings applied to each part. */
  readonly serverSideEncryption?: EncryptionSetting
  /** Effective bucket default encryption used when serverSideEncryption is omitted. */
  readonly bucketDefaultServerSideEncryption?: EncryptionSetting
  /** File retention policy applied at upload time. */
  readonly fileRetention?: FileRetentionValue
  /** Effective readable bucket default retention used when fileRetention is omitted. */
  readonly bucketDefaultRetention?: BucketRetentionPolicy
  /** Bucket default retention exists but cannot be read, so resume must fail closed. */
  readonly bucketDefaultRetentionUnreadable?: boolean
  /** Legal hold status applied at upload time. */
  readonly legalHold?: LegalHoldValue
  /** Size of each part in bytes. Defaults to the account's recommended part size. */
  readonly partSize?: number
  /** Maximum number of parts uploaded in parallel. Defaults to 4. */
  readonly concurrency?: number
  /** Callback invoked with upload progress updates. */
  readonly onProgress?: ProgressListener
  /** Signal to abort the upload. Triggers cancellation of the large file. */
  readonly signal?: AbortSignal
  /**
   * If true, look for an unfinished large file with the same bucket and file name
   * and continue uploading into it. Automatic discovery only reuses unfinished
   * files whose upload options and already-uploaded part lengths match;
   * otherwise a new large file is started. Existing server parts are overwritten
   * with locally read bytes instead of being trusted by SHA-1 alone.
   *
   * Discovery runs before the first upload byte and can make up to the
   * list-page budget plus the candidate budget times the part-page budget in
   * sequential B2 list calls. Pass `resumeDiscoveryTimeoutMs` or an
   * `AbortSignal` to enforce a hard discovery deadline. SSE-C uploads are
   * never auto-resumed because B2 does not expose the customer key identity
   * needed to verify a compatible unfinished file. Candidates with unreadable
   * Object Lock fields are rejected unless the caller provides explicit
   * settings that can be verified.
   */
  readonly resume?: boolean
  /** Optional aggregate SDK-enforced timeout for resume discovery. */
  readonly resumeDiscoveryTimeoutMs?: number
  /**
   * Maximum `b2_list_unfinished_large_files` pages inspected before upload starts. Defaults to 10.
   * If the scan truncates, resume falls back to a fresh upload and
   * `onResumeCandidateRejected` is the only SDK signal.
   */
  readonly resumeMaxListPages?: number
  /**
   * Maximum metadata-compatible candidates whose parts may be listed before upload starts. Defaults to 25.
   * Hitting the limit can leave older unfinished uploads orphaned while a fresh
   * large file is started; tune for high-churn buckets.
   */
  readonly resumeMaxPartCandidates?: number
  /**
   * Maximum `b2_list_parts` pages inspected per metadata-compatible candidate before upload starts. Defaults to 10.
   * A candidate whose parts exceed this bound is skipped and reported through
   * `onResumeCandidateRejected`.
   */
  readonly resumeMaxPartPages?: number
  /**
   * Explicit large file ID to resume into. Overrides {@link resume} discovery
   * after verifying that the ID belongs to the requested bucket/file name and
   * matches the current upload options and already-uploaded part lengths. This
   * verification also rejects SSE-C uploads because B2 does not expose
   * customer key identity for unfinished files. A mismatch, or a file ID that
   * cannot be verified through B2's unfinished-large-file listing, throws
   * {@link ResumeFileIdMismatchError}. Unreadable Object Lock fields reject
   * the candidate.
   */
  readonly resumeFileId?: LargeFileId
  /** Diagnostic callback invoked when resume discovery rejects a candidate. */
  readonly onResumeCandidateRejected?: ResumeCandidateRejectedListener
  /** Diagnostic callback invoked when resume reuses an already-uploaded part. */
  readonly onResumePartReused?: ResumePartReusedListener
}

interface StartLargeFileResumeRequest {
  readonly contentType: string
  readonly fileInfo: Record<string, string>
  readonly serverSideEncryption?: EncryptionSetting
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
}

function createResumeCandidateCriteria(
  options: UploadLargeFileOptions,
  request: StartLargeFileResumeRequest,
  totalSize: number,
  partSize: number,
  parts: readonly RangePlan[],
): ResumeCandidateCriteria {
  return {
    contentType: request.contentType,
    fileInfo: request.fileInfo,
    sourceSize: totalSize,
    partSize,
    parts,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(request.serverSideEncryption !== undefined
      ? { serverSideEncryption: request.serverSideEncryption }
      : options.bucketDefaultServerSideEncryption !== undefined
        ? { serverSideEncryption: options.bucketDefaultServerSideEncryption }
        : {}),
    ...(request.fileRetention !== undefined
      ? { fileRetention: request.fileRetention }
      : options.bucketDefaultRetention !== undefined
        ? { defaultFileRetention: options.bucketDefaultRetention }
        : options.bucketDefaultRetentionUnreadable === true
          ? { defaultFileRetentionUnreadable: true }
          : {}),
    ...(request.legalHold !== undefined ? { legalHold: request.legalHold } : {}),
    ...(options.resumeDiscoveryTimeoutMs !== undefined
      ? { discoveryTimeoutMs: options.resumeDiscoveryTimeoutMs }
      : {}),
    ...(options.onResumeCandidateRejected !== undefined
      ? { onCandidateRejected: options.onResumeCandidateRejected }
      : {}),
    ...(options.resumeMaxListPages !== undefined
      ? { maxListPages: options.resumeMaxListPages }
      : {}),
    ...(options.resumeMaxPartCandidates !== undefined
      ? { maxPartCandidates: options.resumeMaxPartCandidates }
      : {}),
    ...(options.resumeMaxPartPages !== undefined
      ? { maxPartPages: options.resumeMaxPartPages }
      : {}),
  }
}

/**
 * Uploads a file using the B2 multipart (large file) protocol.
 *
 * The source is sliced into parts and uploaded concurrently via
 * `b2_upload_part`. This is appropriate for files larger than the recommended
 * part size. For smaller files, use {@link uploadSmallFile} which sends the
 * entire payload in a single request.
 *
 * On failure, the in-progress large file is cancelled on a best-effort basis.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state (tokens, URLs, upload URL pool).
 * @param options - Upload parameters including part size and concurrency.
 *
 * @returns The resulting {@link FileVersion} metadata.
 */
export async function uploadLargeFile(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadLargeFileOptions,
): Promise<FileVersion> {
  const recommendedPartSize = accountInfo.getRecommendedPartSize()
  const minPartSize = accountInfo.getAbsoluteMinimumPartSize()
  const partSize = Math.max(options.partSize ?? recommendedPartSize, minPartSize)
  const concurrency = options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY
  const totalSize = options.source.size

  const parts = planRanges(totalSize, partSize)
  // Keep caller fileInfo on a null-prototype record so resume identity
  // comparison only sees caller-owned enumerable keys.
  const fileInfo: Record<string, string> = Object.create(null)
  if (options.fileInfo !== undefined) {
    for (const [key, value] of Object.entries(options.fileInfo)) {
      fileInfo[key] = value
    }
  }

  // Construct the `b2_start_large_file` request body once so the two
  // non-resume branches below (no `resume`, resume-but-no-candidate)
  // can dispatch without re-spelling the conditional spreads.
  const startLargeFileRequest = {
    bucketId: options.bucketId,
    fileName: options.fileName,
    contentType: options.contentType ?? DEFAULT_CONTENT_TYPE,
    fileInfo,
    ...(options.serverSideEncryption !== undefined
      ? { serverSideEncryption: options.serverSideEncryption }
      : {}),
    ...(options.fileRetention !== undefined ? { fileRetention: options.fileRetention } : {}),
    ...(options.legalHold !== undefined ? { legalHold: options.legalHold } : {}),
  }
  const resumeCandidateCriteria = createResumeCandidateCriteria(
    options,
    startLargeFileRequest,
    totalSize,
    partSize,
    parts,
  )

  if (!options.source.canSlice && options.resumeFileId !== undefined) {
    throw new Error('uploadLargeFile: resume is not supported on non-sliceable sources.')
  }

  // --- Explicit resume file reuse (M11.1) ---
  let largeFileId: LargeFileId | undefined
  let preUploaded: ReadonlyMap<number, string> = new Map()
  let createdLargeFile = false
  const abortScope = createAbortScope(options.signal)
  const startFreshLargeFile = async (): Promise<void> => {
    if (abortScope.signal.aborted && !options.source.canSlice) {
      await cancelForwardOnlySource(options.source, abortScope.signal.reason)
    }
    abortScope.signal.throwIfAborted()
    const startPromise = raw.startLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      startLargeFileRequest,
      {
        signal: abortScope.signal,
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
      },
    )
    try {
      const startResp = await raceWithAbort(startPromise, abortScope.signal)
      largeFileId = startResp.fileId
    } catch (err) {
      if (abortScope.signal.aborted) {
        if (!options.source.canSlice) {
          await cancelForwardOnlySource(options.source, abortScope.signal.reason).catch(() => {})
        }
        cancelLargeFileAfterStart(startPromise, raw, accountInfo, options.onCleanupFailure)
      }
      throw err
    }
    preUploaded = new Map<number, string>()
    createdLargeFile = true
  }

  try {
    if (abortScope.signal.aborted && !options.source.canSlice) {
      await cancelForwardOnlySource(options.source, abortScope.signal.reason)
    }
    abortScope.signal.throwIfAborted()
    if (options.resumeFileId !== undefined) {
      const candidate = await findResumeCandidate(
        raw,
        accountInfo,
        options.bucketId,
        options.fileName,
        {
          ...resumeCandidateCriteria,
          resumeFileId: options.resumeFileId,
        },
      )
      if (candidate === null) {
        throw new ResumeFileIdMismatchError(options.resumeFileId, options.fileName)
      }
      largeFileId = candidate.fileId
      preUploaded = candidate.uploadedPartSha1s
    } else if (options.resume === true && options.source.canSlice) {
      const candidate = await findResumeCandidate(
        raw,
        accountInfo,
        options.bucketId,
        options.fileName,
        resumeCandidateCriteria,
      )
      if (candidate) {
        largeFileId = candidate.fileId
        preUploaded = new Map<number, string>()
      } else {
        await startFreshLargeFile()
      }
    } else {
      await startFreshLargeFile()
    }
    const activeLargeFileId = largeFileId
    if (activeLargeFileId === undefined) {
      throw new Error('uploadLargeFile: start did not return a large file ID.')
    }

    const partSha1s: string[] = new Array(parts.length)
    const tracker = new ProgressTracker(options.onProgress, totalSize, parts.length)
    const sem = new Semaphore(concurrency)

    // Non-sliceable sources can't be read in parallel — there's only one
    // forward-only cursor. Resume is also impossible (no seek). Bail to a
    // sequential read loop instead. Each part is buffered, hashed, shipped,
    // then dropped before the next read starts, so the peak memory footprint is
    // ~partSize bytes regardless of total file size.
    if (!options.source.canSlice) {
      await uploadPartsSequentially(
        raw,
        accountInfo,
        options,
        activeLargeFileId,
        parts,
        partSha1s,
        tracker,
        abortScope.signal,
      )
      return await finishLargeFileWithAbortReconciliation(raw, accountInfo, {
        fileId: activeLargeFileId,
        bucketId: options.bucketId,
        fileName: options.fileName,
        partSha1s,
        signal: abortScope.signal,
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
      })
    }

    const tasks = parts.map(async (part) => {
      await sem.acquire()
      try {
        abortScope.signal.throwIfAborted()

        const partSource = options.source.slice(part.offset, part.offset + part.length)
        const data = new Uint8Array(await partSource.toArrayBuffer({ signal: abortScope.signal }))
        abortScope.signal.throwIfAborted()

        const partSha1 = new IncrementalSha1()
        await partSha1.update(data)
        const sha1Hex = await partSha1.digest()
        abortScope.signal.throwIfAborted()

        // Explicit resume is the only mode that trusts an already-uploaded
        // server part enough to skip sending the local bytes again.
        const serverSha1 = preUploaded.get(part.partNumber)
        if (serverSha1 !== undefined && serverSha1 === sha1Hex) {
          notifyResumePartReused(options.onResumePartReused, {
            fileName: options.fileName,
            fileId: activeLargeFileId,
            partNumber: part.partNumber,
            contentLength: data.byteLength,
            contentSha1: serverSha1,
          })
          partSha1s[part.partNumber - 1] = serverSha1
          tracker.addBytes(data.byteLength)
          tracker.completePart()
          return
        }

        const result = await uploadPartWithFreshUrl(raw, accountInfo, activeLargeFileId, {
          fileName: options.fileName,
          partNumber: part.partNumber,
          data,
          contentLength: data.byteLength,
          contentSha1: sha1Hex,
          retry: options.retry,
          signal: abortScope.signal,
          onUploadRetry: options.onUploadRetry,
          retryResponseBodyFailures: resolveRetryResponseBodyFailures(
            options.retryResponseBodyFailures,
          ),
          ...(options.serverSideEncryption !== undefined
            ? { serverSideEncryption: options.serverSideEncryption }
            : {}),
        })

        partSha1s[part.partNumber - 1] = result.contentSha1
        tracker.addBytes(data.byteLength)
        tracker.completePart()
      } catch (err) {
        abortScope.abort(err)
        throw err
      } finally {
        sem.release()
      }
    })

    throwRejectedOrAbortReason(await Promise.allSettled(tasks), abortScope)

    const result = await finishLargeFileWithAbortReconciliation(raw, accountInfo, {
      fileId: activeLargeFileId,
      bucketId: options.bucketId,
      fileName: options.fileName,
      partSha1s,
      signal: abortScope.signal,
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    })

    return result
  } catch (err) {
    abortScope.abort(err)
    if (largeFileId === undefined) throw err
    return await cleanupAfterUploadLargeFileError(
      err,
      raw,
      accountInfo,
      options,
      largeFileId,
      createdLargeFile,
    )
  } finally {
    abortScope.dispose()
  }
}

function cancelLargeFileAfterStart(
  started: Promise<{ readonly fileId: LargeFileId }>,
  raw: RawClient,
  accountInfo: AccountInfo,
  onCleanupFailure: CleanupFailureOptions['onCleanupFailure'],
): void {
  void started
    .then((resp) =>
      cancelLargeFileBestEffort(
        raw,
        accountInfo,
        resp.fileId,
        onCleanupFailure === undefined ? undefined : { onCleanupFailure },
      ),
    )
    .catch(() => {
      // If start failed, no file ID is available to cancel.
    })
}

async function cleanupAfterUploadLargeFileError(
  err: unknown,
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadLargeFileOptions,
  largeFileId: LargeFileId,
  createdLargeFile: boolean,
): Promise<never> {
  return await cleanupAfterLargeFileError(
    err,
    raw,
    accountInfo,
    {
      fileId: largeFileId,
      bucketId: options.bucketId,
      fileName: options.fileName,
      signal: options.signal,
      onCleanupFailure: options.onCleanupFailure,
    },
    { cancelOnError: createdLargeFile },
  )
}

/**
 * Sequential upload path for non-sliceable sources.
 *
 * Reads the source's `stream()` once and accumulates exactly `partSize`
 * bytes into an in-memory buffer per iteration. Each filled buffer is
 * hashed, dispatched to `b2_upload_part`, then released before the next
 * part starts — so peak memory is ~partSize regardless of file size.
 *
 * Concurrency is forced to 1 here because the stream is a single
 * forward-only cursor; the engine can't read part N+1 until part N is
 * fully consumed.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - The original `uploadLargeFile` options.
 * @param largeFileId - ID of the in-progress large file (already started).
 * @param parts - Pre-planned part layout (used for part numbers + count).
 * @param partSha1s - Output array, written in-place at index `partNumber - 1`.
 * @param tracker - Progress tracker; bytes added per chunk, part completed
 *   each time a part finishes.
 * @param signal - Linked abort signal for source reads and part uploads.
 */
async function uploadPartsSequentially(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadLargeFileOptions,
  largeFileId: LargeFileId,
  parts: readonly RangePlan[],
  partSha1s: string[],
  tracker: ProgressTracker,
  signal: AbortSignal,
): Promise<void> {
  const reader = options.source.stream().getReader()
  let bytesRead = 0
  // Carry-over bytes from a previous read when the read returned more
  // than we needed to fill one part. Kept as an array to avoid an
  // allocation per loop iteration on a typical multi-part upload.
  let carry: Uint8Array | null = null

  try {
    for (const planned of parts) {
      signal.throwIfAborted()

      const buf = new Uint8Array(planned.length)
      let filled = 0

      if (carry !== null) {
        const take = Math.min(carry.byteLength, buf.byteLength - filled)
        buf.set(carry.subarray(0, take), filled)
        filled += take
        carry = take < carry.byteLength ? carry.subarray(take) : null
      }

      while (filled < buf.byteLength) {
        const { done, value } = await readNextNonEmptyStreamChunk(reader, emptyChunkError(), signal)
        if (done) {
          throw new Error(
            `uploadLargeFile: source stream ended after ${bytesRead} bytes, expected ${options.source.size}.`,
          )
        }
        bytesRead += value.byteLength
        const take = Math.min(value.byteLength, buf.byteLength - filled)
        buf.set(value.subarray(0, take), filled)
        filled += take
        if (take < value.byteLength) {
          carry = value.subarray(take)
        }
      }

      signal.throwIfAborted()
      const data = buf

      const partSha1 = new IncrementalSha1()
      await partSha1.update(data)
      const sha1Hex = await partSha1.digest()
      signal.throwIfAborted()

      const result = await uploadPartWithFreshUrl(raw, accountInfo, largeFileId, {
        fileName: options.fileName,
        partNumber: planned.partNumber,
        data,
        contentLength: data.byteLength,
        contentSha1: sha1Hex,
        retry: options.retry,
        signal,
        onUploadRetry: options.onUploadRetry,
        retryResponseBodyFailures: resolveRetryResponseBodyFailures(
          options.retryResponseBodyFailures,
        ),
        ...(options.serverSideEncryption !== undefined
          ? { serverSideEncryption: options.serverSideEncryption }
          : {}),
      })

      partSha1s[planned.partNumber - 1] = result.contentSha1
      tracker.addBytes(data.byteLength)
      tracker.completePart()
    }
    if (carry !== null && carry.byteLength > 0) {
      throw new Error(tooManyBytesError(options.source.size))
    }
    const extra = await readNextNonEmptyStreamChunk(reader, emptyChunkError(), signal)
    if (!extra.done) {
      bytesRead += extra.value.byteLength
      throw new Error(tooManyBytesError(options.source.size))
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  } finally {
    // Releasing the lock lets the underlying stream propagate close / error
    // events to any upstream producer (e.g. a Node `Readable`).
    reader.releaseLock()
  }
}

function emptyChunkError(): string {
  return `uploadLargeFile: source stream emitted more than ${MAX_CONSECUTIVE_EMPTY_STREAM_CHUNKS} consecutive empty chunks. too many empty chunks.`
}

function tooManyBytesError(advertisedSize: number): string {
  return `uploadLargeFile: source stream emitted more than advertised ${advertisedSize} bytes. source stream emitted more bytes than advertised size.`
}

async function cancelForwardOnlySource(source: ContentSource, reason: unknown): Promise<void> {
  const reader = source.stream().getReader()
  try {
    await reader.cancel(reason)
  } finally {
    reader.releaseLock()
  }
}

function notifyResumePartReused(
  listener: ResumePartReusedListener | undefined,
  event: ResumePartReusedEvent,
): void {
  try {
    listener?.(event)
  } catch {
    // Diagnostic observers must not change upload success or failure.
  }
}
