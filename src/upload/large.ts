import type { AccountInfo } from '../auth/account-info.ts'
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
import { type RangePlan, planRanges } from '../util/plan-ranges.ts'
import { cancelLargeFileBestEffort } from './cancel.ts'
import { Semaphore } from './concurrency.ts'
import { collectPartSha1s, findResumeCandidate } from './resume.ts'

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
  /**
   * If true, look for an unfinished large file with the same bucket and file name
   * and skip parts whose locally-recomputed SHA-1 matches the server's.
   */
  readonly resume?: boolean
  /**
   * Explicit large file ID to resume into. Overrides {@link resume} discovery
   * but the local `partSize` must still match the server's plan.
   */
  readonly resumeFileId?: LargeFileId
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
  const fileInfo: Record<string, string> = { ...options.fileInfo }

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

  // --- Resume discovery (M11.1) ---
  let largeFileId: LargeFileId
  let preUploaded: ReadonlyMap<number, string>

  if (options.resumeFileId !== undefined) {
    largeFileId = options.resumeFileId
    preUploaded = await collectPartSha1s(raw, accountInfo, largeFileId)
  } else if (options.resume === true) {
    const candidate = await findResumeCandidate(
      raw,
      accountInfo,
      options.bucketId,
      options.fileName,
    )
    if (candidate) {
      largeFileId = candidate.fileId
      preUploaded = candidate.uploadedPartSha1s
    } else {
      const startResp = await raw.startLargeFile(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        startLargeFileRequest,
      )
      largeFileId = startResp.fileId
      preUploaded = new Map<number, string>()
    }
  } else {
    const startResp = await raw.startLargeFile(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      startLargeFileRequest,
    )
    largeFileId = startResp.fileId
    preUploaded = new Map<number, string>()
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
    if (options.resume === true || options.resumeFileId !== undefined) {
      // Cancel the unfinished large file before throwing so the caller
      // doesn't have to clean it up themselves.
      await cancelLargeFileBestEffort(raw, accountInfo, largeFileId)
      throw new Error(
        'uploadLargeFile: resume is not supported on non-sliceable sources (e.g. StreamSource).',
      )
    }
    try {
      await uploadPartsSequentially(
        raw,
        accountInfo,
        options,
        largeFileId,
        parts,
        partSha1s,
        tracker,
      )
      return await raw.finishLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
        fileId: largeFileId,
        partSha1Array: partSha1s,
      })
    } catch (err) {
      await cancelLargeFileBestEffort(raw, accountInfo, largeFileId)
      throw err
    }
  }

  try {
    const tasks = parts.map(async (part) => {
      await sem.acquire()
      try {
        options.signal?.throwIfAborted()

        const partSource = options.source.slice(part.offset, part.offset + part.length)
        const data = new Uint8Array(await partSource.toArrayBuffer())

        const partSha1 = new IncrementalSha1()
        await partSha1.update(data)
        const sha1Hex = await partSha1.digest()

        // Resume short-circuit: server already has this part with matching SHA-1
        const serverSha1 = preUploaded.get(part.partNumber)
        if (serverSha1 !== undefined && serverSha1 === sha1Hex) {
          partSha1s[part.partNumber - 1] = serverSha1
          tracker.addBytes(data.byteLength)
          tracker.completePart()
          return
        }

        let uploadEntry = accountInfo.checkoutPartUploadUrl(largeFileId)
        if (!uploadEntry) {
          const resp = await raw.getUploadPartUrl(
            accountInfo.getApiUrl(),
            accountInfo.getAuthToken(),
            { fileId: largeFileId },
          )
          uploadEntry = { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
        }

        try {
          const result = await raw.uploadPart(
            uploadEntry.uploadUrl,
            {
              authorization: uploadEntry.authorizationToken,
              partNumber: part.partNumber,
              contentLength: data.byteLength,
              contentSha1: sha1Hex,
              ...(options.serverSideEncryption !== undefined
                ? { serverSideEncryption: options.serverSideEncryption }
                : {}),
            },
            data,
            options.signal,
          )

          accountInfo.returnPartUploadUrl(largeFileId, uploadEntry)
          partSha1s[part.partNumber - 1] = result.contentSha1
          tracker.addBytes(data.byteLength)
          tracker.completePart()
        } catch (err) {
          accountInfo.evictPartUploadUrl(largeFileId, uploadEntry)
          throw err
        }
      } finally {
        sem.release()
      }
    })

    await Promise.all(tasks)

    const result = await raw.finishLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId: largeFileId,
      partSha1Array: partSha1s,
    })

    return result
  } catch (err) {
    await cancelLargeFileBestEffort(raw, accountInfo, largeFileId)
    throw err
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
      options.signal?.throwIfAborted()

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

      let uploadEntry = accountInfo.checkoutPartUploadUrl(largeFileId)
      if (!uploadEntry) {
        const resp = await raw.getUploadPartUrl(
          accountInfo.getApiUrl(),
          accountInfo.getAuthToken(),
          { fileId: largeFileId },
        )
        uploadEntry = { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
      }

      try {
        const result = await raw.uploadPart(
          uploadEntry.uploadUrl,
          {
            authorization: uploadEntry.authorizationToken,
            partNumber: planned.partNumber,
            contentLength: data.byteLength,
            contentSha1: sha1Hex,
            ...(options.serverSideEncryption !== undefined
              ? { serverSideEncryption: options.serverSideEncryption }
              : {}),
          },
          data,
          options.signal,
        )

        accountInfo.returnPartUploadUrl(largeFileId, uploadEntry)
        partSha1s[planned.partNumber - 1] = result.contentSha1
        tracker.addBytes(data.byteLength)
        tracker.completePart()
      } catch (err) {
        accountInfo.evictPartUploadUrl(largeFileId, uploadEntry)
        throw err
      }

      partNumber++
    }
  } finally {
    // Releasing the lock lets the underlying stream propagate close /
    // error events to any upstream producer (e.g. a Node `Readable`).
    reader.releaseLock()
  }
}
