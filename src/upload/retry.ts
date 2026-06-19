import type { AccountInfo, UploadUrlEntry } from '../auth/account-info.ts'
import { B2Error, NetworkError } from '../errors/index.ts'
import { computeBackoff, DEFAULT_RETRY_OPTIONS, type RetryOptions, sleep } from '../http/retry.ts'
import type { RawClient } from '../raw/index.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'

/** Internal options for upload-layer fresh-URL retries. */
export interface UploadLayerRetryOptions {
  /** Retry settings shared with the main transport retry configuration. */
  readonly retry?: Partial<RetryOptions> | undefined
  /** Abort signal for cancelling upload attempts and retry backoff sleeps. */
  readonly signal?: AbortSignal | undefined
}

interface FreshUrlRetryOptions<T> extends UploadLayerRetryOptions {
  readonly checkout: () => UploadUrlEntry | null
  readonly fetchFresh: () => Promise<UploadUrlEntry>
  readonly returnEntry: (entry: UploadUrlEntry) => void
  readonly evictEntry: (entry: UploadUrlEntry) => void
  readonly upload: (entry: UploadUrlEntry) => Promise<T>
}

/**
 * Fetches a small-file upload URL, bypassing the pool.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Bucket to upload into.
 *
 * @returns A fresh upload URL entry.
 */
export async function fetchFreshUploadUrl(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
): Promise<UploadUrlEntry> {
  const resp = await raw.getUploadUrl(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    bucketId,
  })
  return { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
}

/**
 * Fetches a large-file part upload URL, bypassing the pool.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - Large file to upload a part into.
 *
 * @returns A fresh part upload URL entry.
 */
export async function fetchFreshPartUploadUrl(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
): Promise<UploadUrlEntry> {
  const resp = await raw.getUploadPartUrl(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    fileId,
  })
  return { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
}

/**
 * Runs an upload operation with B2's documented retry flow: evict the failed
 * upload URL, back off, fetch a fresh upload URL, and retry there.
 *
 * Sending the POST again after a lost success response can create a duplicate
 * file version; this is the idempotency tradeoff B2 documents for upload
 * retries.
 *
 * @param options - URL checkout, upload, eviction, and retry callbacks.
 *
 * @returns The successful upload result.
 */
export async function withFreshUploadUrlRetry<T>(options: FreshUrlRetryOptions<T>): Promise<T> {
  const retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry }
  let lastRetryableError: B2Error | NetworkError | undefined

  for (let attempt = 0; attempt <= retryOptions.maxRetries; attempt++) {
    if (attempt > 0 && lastRetryableError !== undefined) {
      const retryAfter =
        lastRetryableError instanceof B2Error ? lastRetryableError.retryAfter : undefined
      const delay = computeBackoff(attempt - 1, retryOptions, retryAfter)
      await sleep(delay, options.signal)
    }

    options.signal?.throwIfAborted()
    const uploadEntry =
      attempt === 0
        ? (options.checkout() ?? (await options.fetchFresh()))
        : await options.fetchFresh()

    try {
      const result = await options.upload(uploadEntry)
      options.returnEntry(uploadEntry)
      return result
    } catch (err) {
      options.evictEntry(uploadEntry)
      if (!isUploadRetryable(err) || attempt === retryOptions.maxRetries) {
        throw err
      }
      lastRetryableError = err
    }
  }

  throw lastRetryableError ?? new NetworkError('Upload retry budget exhausted')
}

function isUploadRetryable(err: unknown): err is B2Error | NetworkError {
  if (err instanceof NetworkError) return true
  return err instanceof B2Error && err.retryable
}
