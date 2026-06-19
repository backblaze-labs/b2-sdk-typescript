import type { RetryOptions } from '../http/retry.ts'

const uploadRetryOptionsByClient = new WeakMap<object, RetryOptions>()

/**
 * Stores resolved upload retry options for a B2Client instance.
 * @param client - Client instance.
 * @param options - Resolved retry options.
 */
export function setClientUploadRetryOptions(client: object, options: RetryOptions): void {
  uploadRetryOptionsByClient.set(client, options)
}

/**
 * Returns resolved upload retry options for a B2Client instance.
 * @param client - Client instance.
 *
 * @returns Resolved retry options.
 *
 * @throws If the client was not initialized through B2Client.
 */
export function getClientUploadRetryOptions(client: object): RetryOptions {
  const retryOptions = uploadRetryOptionsByClient.get(client)
  if (retryOptions === undefined) {
    throw new Error('B2Client upload retry options are unavailable')
  }
  return retryOptions
}
