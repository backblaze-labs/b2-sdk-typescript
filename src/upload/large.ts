import type { AccountInfo } from '../auth/account-info.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import type { ProgressListener } from '../streams/progress.ts'
import { ProgressTracker } from '../streams/progress.ts'
import type { ContentSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import { DEFAULT_CONTENT_TYPE, DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { planRanges, type RangePlan } from '../util/plan-ranges.ts'
import { createUploadAbortScope } from './abort-scope.ts'
import { cancelLargeFileBestEffort } from './cancel.ts'
import { Semaphore } from './concurrency.ts'
import {
  findResumeCandidate,
  type ResumeCandidateCriteria,
  type ResumeCandidateRejectedListener,
  ResumeFileIdMismatchError,
} from './resume.ts'
import {
  resolveRetryResponseBodyFailures,
  type UploadRetryListener,
  uploadPartWithFreshUrl,
} from './retry.ts'

/** Event emitted when resume skips a local part because B2 already has matching SHA-1 bytes. */
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

/** Callback invoked when resume accepts a pre-existing server part. */
export type ResumePartReusedListener = (event: ResumePartReusedEvent) => void

/** Options for uploading a large file via the multipart protocol. */
export interface UploadLargeFileOptions {
  /** Target bucket for the upload. */
  readonly bucketId: BucketId
  /** Full B2 file name including any path prefix. */
  readonly fileName: string
  /**
   * Content to upload. Sliceable sources ({@link BufferSource},
   * {@link BlobSource}) use the parallel-parts path. Non-sliceable
   * sources ({@link StreamSource}) fall back to a sequential read path
   * — one part at a time, concurrency forced to 1 — so callers can
   * stream a multi-GB file without buffering the whole payload in
   * memory. The `resume` / `resumeFileId` options require a sliceable
   * source; they throw on a `StreamSource`.
   */
  readonly source: ContentSource
  /** MIME type. Defaults to `b2/x-auto` for server-side detection. */
  readonly contentType?: string
  /** Custom file info key/value pairs stored with the file. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption settings applied to each part. */
  readonly serverSideEncryption?: EncryptionSetting
  /** File retention policy applied at upload time. */
  readonly fileRetention?: FileRetentionValue
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
  /** Retry settings for upload-layer fresh-URL retries. */
  readonly retry?: Partial<RetryOptions>
  /** Callback invoked before retrying with a fresh upload URL. */
  readonly onUploadRetry?: UploadRetryListener
  /**
   * Retry when an upload response body cannot be read after B2 may have stored
   * the part. Defaults to true because re-posting the same part number is
   * idempotent; set false to avoid re-sending the part.
   */
  readonly retryResponseBodyFailures?: boolean
  /**
   * If true, look for an unfinished large file with the same bucket and file name
   * and skip parts whose locally-recomputed SHA-1 matches the server's. Automatic
   * discovery only reuses unfinished files whose upload options and already
   * uploaded part lengths match; otherwise a new large file is started.
   *
   * Auto-discovery trusts unfinished large files created by any writer with
   * access to the bucket. Use it only when bucket writers are mutually trusted,
   * and use `onResumePartReused` to observe any server parts accepted through
   * the SHA-1 gate. Discovery runs before the first upload byte and can make up
   * to the list-page budget plus the candidate budget times the part-page
   * budget in sequential B2 list calls; pass `signal` to bound wall-clock time.
   * SSE-C uploads are never auto-resumed because B2 does not expose the
   * customer key identity needed to verify a compatible unfinished file.
   * Candidates with unreadable Object Lock retention or legal-hold fields are
   * rejected because automatic discovery cannot prove they are unlocked.
   */
  readonly resume?: boolean
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
   * {@link ResumeFileIdMismatchError}.
   * When `fileRetention` and `legalHold` are omitted, this explicit ID is the
   * trust decision for unreadable Object Lock fields on that unfinished file.
   */
  readonly resumeFileId?: LargeFileId
  /** Diagnostic callback invoked when resume discovery rejects a candidate. */
  readonly onResumeCandidateRejected?: ResumeCandidateRejectedListener
  /** Diagnostic callback invoked when resume reuses an already-uploaded part. */
  readonly onResumePartReused?: ResumePartReusedListener
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
  const resumeCandidateCriteria: ResumeCandidateCriteria = {
    contentType: startLargeFileRequest.contentType,
    fileInfo: startLargeFileRequest.fileInfo,
    sourceSize: totalSize,
    partSize,
    parts,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(startLargeFileRequest.serverSideEncryption !== undefined
      ? { serverSideEncryption: startLargeFileRequest.serverSideEncryption }
      : {}),
    ...(startLargeFileRequest.fileRetention !== undefined
      ? { fileRetention: startLargeFileRequest.fileRetention }
      : {}),
    ...(startLargeFileRequest.legalHold !== undefined
      ? { legalHold: startLargeFileRequest.legalHold }
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

  // --- Resume discovery (M11.1) ---
  if (!options.source.canSlice && options.resumeFileId !== undefined) {
    throw new Error(
      'uploadLargeFile: resume is not supported on non-sliceable sources (e.g. StreamSource).',
    )
  }

  let largeFileId: LargeFileId
  let preUploaded: ReadonlyMap<number, string>
  let createdLargeFile = false
  const controlOptions = options.signal !== undefined ? { signal: options.signal } : undefined

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
      preUploaded = candidate.uploadedPartSha1s
    } else {
      const startResp = await raw.startLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        startLargeFileRequest,
        controlOptions,
      )
      largeFileId = startResp.fileId
      preUploaded = new Map<number, string>()
      createdLargeFile = true
    }
  } else {
    const startResp = await raw.startLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      startLargeFileRequest,
      controlOptions,
    )
    largeFileId = startResp.fileId
    preUploaded = new Map<number, string>()
    createdLargeFile = true
  }

  const partSha1s: string[] = new Array(parts.length)
  const tracker = new ProgressTracker(options.onProgress, totalSize, parts.length)
  const sem = new Semaphore(concurrency)

  // Non-sliceable sources (e.g. `StreamSource` wrapping a Node
  // `Readable.toWeb`) can't be read in parallel — there's only one
  // forward-only cursor. Resume is also impossible (no seek). Bail to a
  // sequential read loop instead. Each part is buffered, hashed,
  // shipped, then dropped before the next read starts, so the peak
  // memory footprint is ~partSize bytes regardless of total file size.
  if (!options.source.canSlice) {
    const abortScope = createUploadAbortScope(options.signal)
    try {
      await uploadPartsSequentially(
        raw,
        accountInfo,
        options,
        abortScope.signal,
        largeFileId,
        parts,
        partSha1s,
        tracker,
      )
      return await raw.finishLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        {
          fileId: largeFileId,
          partSha1Array: partSha1s,
        },
        { signal: abortScope.signal },
      )
    } catch (err) {
      abortScope.abort(err)
      if (createdLargeFile) {
        await cancelLargeFileBestEffort(raw, accountInfo, largeFileId, {
          signal: abortScope.signal,
        })
      }
      throw err
    } finally {
      abortScope.dispose()
    }
  }

  const abortScope = createUploadAbortScope(options.signal)
  try {
    const tasks = parts.map(async (part) => {
      await sem.acquire()
      try {
        abortScope.signal.throwIfAborted()

        const partSource = options.source.slice(part.offset, part.offset + part.length)
        const data = new Uint8Array(await partSource.toArrayBuffer())
        abortScope.signal.throwIfAborted()

        const partSha1 = new IncrementalSha1()
        await partSha1.update(data)
        const sha1Hex = await partSha1.digest()
        abortScope.signal.throwIfAborted()

        // Best-effort resume deduplication gate: metadata and lengths are not enough.
        // A SHA-1 match is not a cryptographic guarantee against malicious
        // bucket co-writers, so auto-resume is documented for mutually trusted
        // writers only.
        const serverSha1 = preUploaded.get(part.partNumber)
        if (serverSha1 !== undefined && serverSha1 === sha1Hex) {
          notifyResumePartReused(options.onResumePartReused, {
            fileName: options.fileName,
            fileId: largeFileId,
            partNumber: part.partNumber,
            contentLength: data.byteLength,
            contentSha1: serverSha1,
          })
          partSha1s[part.partNumber - 1] = serverSha1
          tracker.addBytes(data.byteLength)
          tracker.completePart()
          return
        }

        const result = await uploadPartWithFreshUrl(raw, accountInfo, largeFileId, {
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
            'multipart',
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

    const settled = await Promise.allSettled(tasks)
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (rejected !== undefined) {
      if (abortScope.signal.aborted && abortScope.signal.reason !== undefined) {
        throw abortScope.signal.reason
      }
      /* v8 ignore next -- Defensive fallback for unexpected task rejections outside the abort scope. */
      throw rejected.reason
    }

    const result = await raw.finishLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      {
        fileId: largeFileId,
        partSha1Array: partSha1s,
      },
      { signal: abortScope.signal },
    )

    return result
  } catch (err) {
    abortScope.abort(err)
    if (createdLargeFile) {
      await cancelLargeFileBestEffort(raw, accountInfo, largeFileId, {
        signal: abortScope.signal,
      })
    }
    throw err
  } finally {
    abortScope.dispose()
  }
}

/**
 * Sequential upload path for non-sliceable sources (`StreamSource`).
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
 * @param signal - Abort signal shared by part uploads and control-plane calls.
 * @param largeFileId - ID of the in-progress large file (already started).
 * @param parts - Pre-planned part layout (used for part numbers + count).
 * @param partSha1s - Output array, written in-place at index `partNumber - 1`.
 * @param tracker - Progress tracker; bytes added per chunk, part completed
 *   each time a part finishes.
 */
async function uploadPartsSequentially(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadLargeFileOptions,
  signal: AbortSignal,
  largeFileId: LargeFileId,
  parts: readonly RangePlan[],
  partSha1s: string[],
  tracker: ProgressTracker,
): Promise<void> {
  const reader = options.source.stream().getReader()
  let partNumber = 1
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
        const { done, value } = await reader.read()
        if (done) break
        const take = Math.min(value.byteLength, buf.byteLength - filled)
        buf.set(value.subarray(0, take), filled)
        filled += take
        if (take < value.byteLength) {
          carry = value.subarray(take)
        }
      }

      signal.throwIfAborted()
      // For the LAST part the stream may run dry mid-buffer, leaving a
      // shorter chunk. B2 accepts a final part smaller than `partSize`.
      const data = filled === buf.byteLength ? buf : buf.subarray(0, filled)
      /* v8 ignore start -- defensive: only fires when the source's advertised
         size over-reports the actual emitted byte count, which a well-behaved
         ContentSource implementation cannot do. Kept so callers feeding the
         engine a buggy custom stream get an actionable error rather than a
         B2 wire-level failure. */
      if (data.byteLength === 0) {
        throw new Error(
          `uploadLargeFile: source stream ended before part ${partNumber}; advertised size does not match emitted bytes.`,
        )
      }
      /* v8 ignore stop */

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
          'multipart',
        ),
        ...(options.serverSideEncryption !== undefined
          ? { serverSideEncryption: options.serverSideEncryption }
          : {}),
      })

      partSha1s[planned.partNumber - 1] = result.contentSha1
      tracker.addBytes(data.byteLength)
      tracker.completePart()

      partNumber++
    }
  } finally {
    // Releasing the lock lets the underlying stream propagate close /
    // error events to any upstream producer (e.g. a Node `Readable`).
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
