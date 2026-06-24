import type { RetryOptions } from '../http/retry.ts'

const uploadRetryOptionsByClient = new WeakMap<object, RetryOptions>()

/**
 * Stores upload retry defaults for a client without exposing them publicly.
 * @param client - Client instance that owns the retry options.
 * @param options - Retry options copied from the client configuration.
 *
 * @internal
 */
export function setClientUploadRetryOptions(client: object, options: RetryOptions): void {
  uploadRetryOptionsByClient.set(client, options)
}

/**
 * Looks up upload retry defaults for a client.
 * @param client - Client instance that owns the retry options.
 *
 * @returns Retry options copied from the client configuration.
 *
 * @throws If the client was not registered with upload retry options.
 *
 * @internal
 */
export function getClientUploadRetryOptions(client: object): RetryOptions {
  const retryOptions = uploadRetryOptionsByClient.get(client)
  if (retryOptions === undefined) {
    throw new Error('B2Client upload retry options are unavailable')
  }
  return retryOptions
}

/**
 * Merges client upload retry defaults with a per-call override.
 * @param client - Client instance that owns the retry options.
 * @param override - Per-call retry option overrides, if any.
 *
 * @returns Retry options for one high-level upload operation.
 *
 * @internal
 */
export function mergeClientUploadRetryOptions(
  client: object,
  override: Partial<RetryOptions> | undefined,
): RetryOptions {
  const defaults = getClientUploadRetryOptions(client)
  if (override === undefined) return defaults
  return { ...defaults, ...override }
}
