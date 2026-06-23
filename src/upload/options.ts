import type { ProgressListener } from '../streams/progress.ts'
import type { ContentSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { LargeFileId } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import type { ResumePartReusedListener } from './large.ts'
import type { ResumeCandidateRejectedListener } from './resume.ts'
import type { UploadRetryListener } from './retry.ts'

/** Options shared by high-level bucket and object upload methods. */
export interface UploadOptions {
  /** Data source to upload. Use {@link BufferSource}, {@link BlobSource}, or {@link StreamSource}. */
  readonly source: ContentSource
  /** MIME type. Defaults to `"b2/x-auto"` (auto-detected by B2). */
  readonly contentType?: string
  /** Custom key-value metadata stored with the file. */
  readonly fileInfo?: Record<string, string>
  /** Server-side encryption settings. */
  readonly serverSideEncryption?: EncryptionSetting
  /** File retention policy (requires file lock on the bucket). */
  readonly fileRetention?: FileRetentionValue
  /** Legal hold status for the file. */
  readonly legalHold?: LegalHoldValue
  /** Last-modified timestamp in milliseconds since epoch. */
  readonly lastModifiedMillis?: number
  /** Part size override for multipart uploads, in bytes. */
  readonly partSize?: number
  /** Number of concurrent part uploads for large files. */
  readonly concurrency?: number
  /** Callback invoked with upload progress events. */
  readonly onProgress?: ProgressListener
  /** Callback invoked before retrying with a fresh upload URL. */
  readonly onUploadRetry?: UploadRetryListener
  /**
   * Configure retries after B2 may have stored bytes. Single-request uploads
   * use this for unreadable response bodies and ambiguous upload POST network
   * failures; it defaults to false because retrying can create duplicate file
   * versions. Multipart uploads use this only for unreadable response bodies;
   * upload POST network failures still retry because re-posting the same part
   * number is idempotent.
   */
  readonly retryResponseBodyFailures?: boolean
  /** Abort signal for cancelling the upload. */
  readonly signal?: AbortSignal
  /** Enable bounded same-name multipart resume discovery. Ignored on the small-file path. */
  readonly resume?: boolean
  /** Aggregate SDK-enforced timeout for resume discovery when no signal is supplied. */
  readonly resumeDiscoveryTimeoutMs?: number
  /** Maximum `b2_list_unfinished_large_files` pages inspected before upload starts. */
  readonly resumeMaxListPages?: number
  /** Maximum metadata-compatible candidates whose parts may be listed before upload starts. */
  readonly resumeMaxPartCandidates?: number
  /** Maximum `b2_list_parts` pages inspected per metadata-compatible candidate. */
  readonly resumeMaxPartPages?: number
  /**
   * Explicit unfinished large-file ID to verify and resume. Only supported on
   * the large-file path; small-file uploads throw.
   */
  readonly resumeFileId?: LargeFileId
  /** Diagnostic callback invoked when resume discovery rejects a candidate. */
  readonly onResumeCandidateRejected?: ResumeCandidateRejectedListener
  /** Diagnostic callback invoked when resume reuses an already-uploaded part. */
  readonly onResumePartReused?: ResumePartReusedListener
}

/** Options accepted by {@link Bucket.upload}. */
export interface BucketUploadOptions extends UploadOptions {
  /** Destination file name (path) in the bucket. */
  readonly fileName: string
}

/** Options accepted by {@link B2Object.upload}. */
export type B2ObjectUploadOptions = UploadOptions

type ResumeOnlyUploadOptions = Pick<
  UploadOptions,
  | 'resume'
  | 'resumeFileId'
  | 'onResumeCandidateRejected'
  | 'onResumePartReused'
  | 'resumeDiscoveryTimeoutMs'
  | 'resumeMaxListPages'
  | 'resumeMaxPartCandidates'
  | 'resumeMaxPartPages'
>

/** High-level upload options after resume-only settings have been removed. */
export type SmallUploadOptions<T extends UploadOptions> = Omit<T, keyof ResumeOnlyUploadOptions>

/**
 * Explicit resume targets are multipart-only and must fail closed on small uploads.
 *
 * @param options - High-level upload options.
 * @param caller - Public method name used in the thrown error.
 *
 * @throws Error when an explicit resume target is supplied for a small upload.
 */
export function rejectSmallResumeFileId(options: UploadOptions, caller: string): void {
  if (options.resumeFileId !== undefined) {
    throw new Error(`${caller}: resumeFileId is only supported for multipart uploads.`)
  }
}

/**
 * Removes resume-only options before forwarding to the small-file upload path.
 *
 * @param options - High-level upload options.
 *
 * @returns Options accepted by the single-request upload implementation.
 */
export function stripResumeOnlyOptions<T extends UploadOptions>(options: T): SmallUploadOptions<T> {
  const {
    resume: _resume,
    resumeFileId: _resumeFileId,
    onResumeCandidateRejected: _onResumeCandidateRejected,
    onResumePartReused: _onResumePartReused,
    resumeDiscoveryTimeoutMs: _resumeDiscoveryTimeoutMs,
    resumeMaxListPages: _resumeMaxListPages,
    resumeMaxPartCandidates: _resumeMaxPartCandidates,
    resumeMaxPartPages: _resumeMaxPartPages,
    ...smallOptions
  } = options
  return smallOptions
}
