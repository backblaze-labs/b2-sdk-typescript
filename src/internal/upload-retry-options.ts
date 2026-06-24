import type { RetryOptions } from '../http/retry.ts'

/**
 * Merges client upload retry defaults with a per-call override.
 * @param defaults - Resolved client upload retry defaults.
 * @param override - Per-call retry option overrides, if any.
 *
 * @returns Retry options for one high-level upload operation.
 *
 * @internal
 */
export function mergeUploadRetryOptions(
  defaults: RetryOptions,
  override: Partial<RetryOptions> | undefined,
): RetryOptions {
  if (override === undefined) return defaults
  return { ...defaults, ...override }
}
