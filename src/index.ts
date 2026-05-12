/**
 * Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript.
 *
 * The root module re-exports the high-level facade ({@link B2Client}, {@link Bucket},
 * {@link B2Object}), error types, auth backends, streaming utilities, HTTP transport,
 * and all request/response type definitions. Most applications only need this import.
 *
 * @packageDocumentation
 */

export { B2Client, type B2ClientOptions, type CapabilityCheckResult } from './client.ts'
export {
  Bucket,
  type DeleteAllDeleteEvent,
  type DeleteAllErrorEvent,
  type DeleteAllEvent,
  type DeleteAllSkipEvent,
  type DeleteError,
  type DeleteManyResult,
  type DeleteTarget,
} from './bucket.ts'
export { B2Object, type DownloadCallOptions } from './object.ts'

export type { UploadWriteHandle } from './upload/stream.ts'

export {
  RawClient,
  type RawClientOptions,
  type DownloadFileOptions,
  type SseCDownloadKey,
} from './raw/index.ts'

export {
  B2Error,
  ExpiredAuthTokenError,
  BadAuthTokenError,
  ServiceUnavailableError,
  RequestTimeoutError,
  TooManyRequestsError,
  CapExceededError,
  AccessDeniedError,
  FileNotPresentError,
  DuplicateBucketNameError,
  BadRequestError,
  BadUploadUrlError,
  ChecksumMismatchError,
  B2InsufficientCapabilityError,
  B2SsrfError,
  NetworkError,
  classifyError,
} from './errors/index.ts'

export { InMemoryAccountInfo } from './auth/in-memory.ts'
export type { AccountInfo, UploadUrlEntry } from './auth/account-info.ts'

export { IncrementalSha1, sha1Hex } from './streams/hash.ts'
export { toContentSource, BlobSource, BufferSource, StreamSource } from './streams/source.ts'
export type { ContentSource } from './streams/source.ts'
export type { ProgressEvent, ProgressListener } from './streams/progress.ts'

export { FetchTransport, RetryTransport } from './http/transport.ts'
export type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  RetryTransportOptions,
} from './http/transport.ts'
export { UrlGuard, deriveAllowedSuffixes } from './http/url-guard.ts'
export type { RetryOptions } from './http/retry.ts'

export type { DownloadResult } from './download/single.ts'

export { SSE_B2, SSE_NONE, sseCustomer } from './types/encryption.ts'

export type * from './types/index.ts'

export { VERSION } from './version.ts'
