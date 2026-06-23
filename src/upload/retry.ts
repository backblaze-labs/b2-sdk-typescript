import type { AccountInfo, UploadUrlEntry } from '../auth/account-info.ts'
import {
  B2Error,
  B2SsrfError,
  BadAuthTokenError,
  BadRequestError,
  BadUploadUrlError,
  NetworkError,
} from '../errors/index.ts'
import { computeBackoff, DEFAULT_RETRY_OPTIONS, type RetryOptions, sleep } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import type { UploadPartResponse } from '../types/upload.ts'

/** Event emitted before an upload is retried against a fresh upload URL. */
export interface UploadRetryEvent {
  /** File name being uploaded. */
  readonly fileName: string
  /** Multipart part number, or `null` for a single-request file upload. */
  readonly partNumber: number | null
  /** One-based retry attempt that is about to run. */
  readonly attempt: number
  /** Maximum number of retry attempts allowed for this upload operation. */
  readonly maxRetries: number
  /** Backoff delay in milliseconds before the fresh URL is fetched. */
  readonly delayMs: number
  /** Classified error that triggered the fresh-URL retry. */
  readonly error: B2Error | NetworkError
}

/** Callback invoked before an upload retry fetches a fresh upload URL. */
export type UploadRetryListener = (event: UploadRetryEvent) => void

/** Internal options for upload-layer fresh-URL retries. */
interface UploadLayerRetryOptions {
  /** Retry settings shared with the main transport retry configuration. */
  readonly retry?: Partial<RetryOptions> | undefined
  /** Abort signal for cancelling upload attempts and retry backoff sleeps. */
  readonly signal?: AbortSignal | undefined
  /** Callback invoked before a fresh-URL upload retry. */
  readonly onUploadRetry?: UploadRetryListener | undefined
  /**
   * Whether response-body read failures after an upload POST should be retried.
   * Defaults to false. Set true to re-send a payload when B2 may have stored it
   * but the success response was lost.
   */
  readonly retryResponseBodyFailures?: boolean | undefined
}

interface FreshUrlRetryOptions<T> extends UploadLayerRetryOptions {
  readonly fileName: string
  readonly partNumber: number | null
  readonly checkout: () => UploadUrlEntry | null
  readonly fetchFresh: () => Promise<UploadUrlEntry>
  readonly returnEntry: (entry: UploadUrlEntry) => void
  readonly evictEntry: (entry: UploadUrlEntry) => void
  readonly upload: (entry: UploadUrlEntry) => Promise<T>
}

const freshUrlRetryOverride: Partial<RetryOptions> = { maxRetries: 0 }

/**
 * Fetches a small-file upload URL, bypassing the pool.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Bucket to upload into.
 * @param signal - Optional abort signal for the fresh URL request.
 *
 * @returns A fresh upload URL entry.
 */
export async function fetchFreshUploadUrl(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
  signal?: AbortSignal,
): Promise<UploadUrlEntry> {
  const resp = await raw.getUploadUrl(
    accountInfo.getApiUrl(),
    accountInfo.getAuthToken(),
    {
      bucketId,
    },
    signal,
    freshUrlRetryOverride,
  )
  return { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
}

/**
 * Fetches a large-file part upload URL, bypassing the pool.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - Large file to upload a part into.
 * @param signal - Optional abort signal for the fresh URL request.
 *
 * @returns A fresh part upload URL entry.
 */
export async function fetchFreshPartUploadUrl(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  signal?: AbortSignal,
): Promise<UploadUrlEntry> {
  const resp = await raw.getUploadPartUrl(
    accountInfo.getApiUrl(),
    accountInfo.getAuthToken(),
    {
      fileId,
    },
    signal,
    freshUrlRetryOverride,
  )
  return { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
}

interface UploadPartWithFreshUrlOptions extends UploadLayerRetryOptions {
  /** File name associated with the large-file upload. */
  readonly fileName: string
  /** One-based part number. */
  readonly partNumber: number
  /** Part bytes to upload. */
  readonly data: BodyInit
  /** Number of bytes in the part. */
  readonly contentLength: number
  /** SHA-1 hex digest of the part bytes. */
  readonly contentSha1: string
  /** Server-side encryption settings for this part. */
  readonly serverSideEncryption?: EncryptionSetting | undefined
}

/**
 * Uploads one multipart part with fresh-URL retry.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - Large file to upload a part into.
 * @param options - Part upload parameters and retry settings.
 *
 * @returns The uploaded part response.
 */
export function uploadPartWithFreshUrl(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  options: UploadPartWithFreshUrlOptions,
): Promise<UploadPartResponse> {
  return withFreshUploadUrlRetry({
    fileName: options.fileName,
    partNumber: options.partNumber,
    retry: options.retry,
    signal: options.signal,
    onUploadRetry: options.onUploadRetry,
    retryResponseBodyFailures: options.retryResponseBodyFailures,
    checkout: () => accountInfo.checkoutPartUploadUrl(fileId),
    fetchFresh: () => fetchFreshPartUploadUrl(raw, accountInfo, fileId, options.signal),
    returnEntry: (entry) => accountInfo.returnPartUploadUrl(fileId, entry),
    evictEntry: (entry) => accountInfo.evictPartUploadUrl(fileId, entry),
    upload: (entry) =>
      raw.uploadPart(
        entry.uploadUrl,
        {
          authorization: entry.authorizationToken,
          partNumber: options.partNumber,
          contentLength: options.contentLength,
          contentSha1: options.contentSha1,
          ...(options.serverSideEncryption !== undefined
            ? { serverSideEncryption: options.serverSideEncryption }
            : {}),
        },
        options.data,
        options.signal,
      ),
  })
}

/**
 * Runs an upload operation with B2's documented retry flow: evict the failed
 * upload URL, back off, fetch a fresh upload URL, and retry there.
 *
 * Sending the POST again after a lost success response can create a duplicate
 * file version. That response-body retry is disabled by default and requires
 * `retryResponseBodyFailures: true`.
 *
 * @param options - URL checkout, upload, eviction, and retry callbacks.
 *
 * @returns The successful upload result.
 */
export async function withFreshUploadUrlRetry<T>(options: FreshUrlRetryOptions<T>): Promise<T> {
  const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry }

  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    let uploadEntry: UploadUrlEntry | undefined

    try {
      options.signal?.throwIfAborted()
      uploadEntry =
        attempt === 0
          ? (options.checkout() ?? (await options.fetchFresh()))
          : await options.fetchFresh()

      const result = await options.upload(uploadEntry)
      options.returnEntry(uploadEntry)
      return result
    } catch (err) {
      const retryError = normalizeUploadRetryError(err, options)
      if (uploadEntry !== undefined) {
        if (isUploadRateLimitError(retryError)) {
          options.returnEntry(uploadEntry)
        } else {
          options.evictEntry(uploadEntry)
        }
      }
      if (options.signal?.aborted) {
        throw err
      }
      if (isUploadRateLimitError(retryError) && uploadEntry !== undefined) {
        throw retryError
      }
      if (!isUploadRetryable(retryError) || attempt === retryOptions.maxRetries) {
        throw retryError
      }

      const retryAttempt = attempt + 1
      const retryAfter = retryError instanceof B2Error ? retryError.retryAfter : undefined
      const delayMs = computeBackoff(attempt, retryOptions, retryAfter)
      options.onUploadRetry?.({
        fileName: options.fileName,
        partNumber: options.partNumber,
        attempt: retryAttempt,
        maxRetries: retryOptions.maxRetries,
        delayMs,
        error: retryError,
      })
      await sleep(delayMs, options.signal)
    }
  }

  // Unreachable at runtime: the loop returns on success or throws from the
  // final failed attempt. This satisfies TypeScript's return-path analysis.
  /* v8 ignore next -- defensive return-path guard. */
  throw new NetworkError('Upload retry budget exhausted')
}

function isUploadRetryable(err: unknown): err is B2Error | NetworkError {
  if (err instanceof NetworkError) return !(err.cause instanceof B2SsrfError)
  if (err instanceof BadAuthTokenError) return true
  if (isUploadUrlInvalidationError(err)) return true
  return err instanceof B2Error && err.retryable
}

function isUploadRateLimitError(err: unknown): err is B2Error {
  return err instanceof B2Error && err.status === 429
}

function normalizeUploadRetryError(err: unknown, options: UploadLayerRetryOptions): unknown {
  if (err instanceof B2Error || err instanceof NetworkError) return err
  if (err instanceof DOMException && err.name === 'AbortError') return err
  if (err instanceof TypeError || err instanceof SyntaxError || err instanceof DOMException) {
    if (options.retryResponseBodyFailures !== true) return err
    const message = err instanceof Error ? err.message : 'Upload response read failed'
    return new NetworkError(message, err)
  }
  return err
}

function isUploadUrlInvalidationError(err: unknown): boolean {
  if (err instanceof BadUploadUrlError) return true
  return err instanceof BadRequestError && /upload url/i.test(err.message)
}
