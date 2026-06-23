import type { RetryOptions } from '../http/retry.ts'

const uploadRetryOptionsByClient = new WeakMap<object, RetryOptions>()

export function setClientUploadRetryOptions(client: object, options: RetryOptions): void {
  uploadRetryOptionsByClient.set(client, options)
}

export function getClientUploadRetryOptions(client: object): RetryOptions {
  const retryOptions = uploadRetryOptionsByClient.get(client)
  if (retryOptions === undefined) {
    throw new Error('B2Client upload retry options are unavailable')
  }
  return retryOptions
}
