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
export { B2Object, type DownloadCallOptions, type HeadCallOptions } from './object.ts'

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

export type { DownloadResult, HeadResult } from './download/single.ts'

export { EncryptionKey, SSE_B2, SSE_NONE, sseCustomer } from './types/encryption.ts'

// Generic pagination helpers. Most callers want the `paginateX()` method
// on `Bucket` / `B2Client`; these are the underlying building blocks for
// paginating raw endpoints or composing custom iteration shapes.
export { paginateItems, paginatePages } from './util/paginator.ts'
export type { PageFetcher, PaginatorOptions } from './util/paginator.ts'

// Named-constant enum objects paired with the string-literal type aliases.
// These give users IDE autocomplete and typo protection
// (`BucketType.AllPrivate` instead of `'allPrivate'`) without breaking the
// existing string-literal call sites. Each export here has a matching type
// of the same name forwarded by the `export type *` line below.
export { BucketRetentionMode, BucketType, CorsOperation } from './types/bucket.ts'
export { Capability } from './types/auth.ts'
export { EncryptionAlgorithm, EncryptionMode } from './types/encryption.ts'
export { EventType } from './types/notifications.ts'
export { FileAction, MetadataDirective } from './types/file.ts'
export { LegalHoldValue, RetentionMode } from './types/lock.ts'

export type * from './types/index.ts'

// Branded-ID factory functions. The `export type *` line above re-exports
// the type aliases (BucketId, FileId, etc.) but value-level factory
// functions are NOT included by `export type *` (it's type-only).
// Without this explicit line, callers can't construct a typed
// `BucketId` / `FileId` / etc. from a raw string at the package
// boundary even though the type IS visible.
export {
  accountId,
  applicationKeyId,
  bucketId,
  fileId,
  keyId,
  largeFileId,
} from './types/ids.ts'

export { VERSION } from './version.ts'
