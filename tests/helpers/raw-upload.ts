import type { B2Client } from '../../src/client.ts'
import { B2Error } from '../../src/errors/index.ts'
import type { BucketId } from '../../src/types/ids.ts'
import type { UploadFileHeaders } from '../../src/types/upload.ts'
import {
  fetchFreshUploadUrl,
  type UploadRetryOptions,
  withFreshUploadUrlRetry,
} from '../../src/upload/retry.ts'

/**
 * Exercise raw upload headers with B2's fresh-target recovery for 5xx responses.
 * Each attempt obtains its own target; no failed URL is returned to a pool.
 * Assertions remain with the caller. Persistent failures still reject.
 *
 * @param client - Authorized test client.
 * @param bucketId - Run-owned test bucket.
 * @param headers - Original raw metadata, excluding the per-attempt token.
 * @param data - Replayable synthetic test bytes.
 * @param options - Retry timing and observation overrides for deterministic tests.
 * @returns The successful raw upload response.
 */
export async function uploadRawFile(
  client: Pick<B2Client, 'raw' | 'accountInfo'>,
  bucketId: BucketId,
  headers: Omit<UploadFileHeaders, 'authorization'>,
  data: Uint8Array,
  options: Pick<UploadRetryOptions, 'retry' | 'onUploadRetry'> = {},
) {
  const signal = AbortSignal.timeout(60_000)
  return withFreshUploadUrlRetry({
    fileName: headers.fileName,
    partNumber: null,
    signal,
    retry: { ...options.retry, maxRetries: Math.min(options.retry?.maxRetries ?? 4, 4) },
    // Never replay an ambiguous successful write or a connection failure here.
    retryResponseBodyFailures: false,
    retryUploadConnectionFaults: false,
    onUploadRetry:
      options.onUploadRetry ??
      ((event) => {
        console.warn('live raw upload: obtaining a fresh target', {
          attempt: event.attempt,
          maxRetries: event.maxRetries,
          status: event.error instanceof B2Error ? event.error.status : undefined,
        })
      }),
    checkout: () => null,
    fetchFresh: () => fetchFreshUploadUrl(client.raw, client.accountInfo, bucketId, signal),
    returnEntry: () => {},
    evictEntry: () => {},
    upload: (entry) =>
      client.raw.uploadFile(
        entry.uploadUrl,
        { ...headers, authorization: entry.authorizationToken },
        data as BodyInit,
        { signal, retry: { maxRetries: 0 } },
      ),
  })
}
