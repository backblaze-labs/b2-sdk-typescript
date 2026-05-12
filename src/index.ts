/**
 * Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript.
 *
 * The root module re-exports the high-level facade ({@link B2Client}, {@link Bucket},
 * {@link B2Object}), error types, auth backends, streaming utilities, HTTP transport,
 * and all request/response type definitions. Most applications only need this import.
 *
 * @packageDocumentation
 */

export { B2Client, type B2ClientOptions } from './client.js'
export { Bucket } from './bucket.js'
export { B2Object } from './object.js'

export { RawClient, type RawClientOptions } from './raw/index.js'

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
  NetworkError,
  classifyError,
} from './errors/index.js'

export { InMemoryAccountInfo } from './auth/in-memory.js'
export type { AccountInfo, UploadUrlEntry } from './auth/account-info.js'

export { IncrementalSha1, sha1Hex } from './streams/hash.js'
export { toContentSource, BlobSource, BufferSource, StreamSource } from './streams/source.js'
export type { ContentSource } from './streams/source.js'
export type { ProgressEvent, ProgressListener } from './streams/progress.js'

export { FetchTransport, RetryTransport } from './http/transport.js'
export type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  RetryTransportOptions,
} from './http/transport.js'
export type { RetryOptions } from './http/retry.js'

export type { DownloadResult } from './download/single.js'

export { SSE_B2, SSE_NONE, sseCustomer } from './types/encryption.js'

export type * from './types/index.js'

export { VERSION } from './version.js'
