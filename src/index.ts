/**
 * Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript.
 *
 * The root module re-exports the high-level facade ({@link B2Client}, {@link Bucket},
 * {@link B2Object}), error types, auth backends, streaming utilities, HTTP transport,
 * and all request/response type definitions. Most applications only need this import.
 *
 * @packageDocumentation
 */

export type {
  AccountInfo,
  AuthContextAwareAccountInfo,
  UploadUrlEntry,
} from './auth/account-info.ts'
export { InMemoryAccountInfo } from './auth/in-memory.ts'
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
export { B2Client, type B2ClientOptions, type CapabilityCheckResult } from './client.ts'
export type { DownloadResult, HeadResult } from './download/single.ts'
export type { B2ErrorOptions } from './errors/index.ts'

export {
  AccessDeniedError,
  B2Error,
  B2InsufficientCapabilityError,
  B2RealmConfigurationError,
  B2RedirectError,
  B2SsrfError,
  BadAuthTokenError,
  BadBucketIdError,
  BadJsonError,
  BadRequestError,
  BadUploadUrlError,
  CapExceededError,
  ChecksumMismatchError,
  ConflictError,
  classifyError,
  DuplicateBucketNameError,
  ExpiredAuthTokenError,
  FileNotPresentError,
  InternalError,
  InvalidBucketIdError,
  InvalidBucketInfoError,
  InvalidBucketNameError,
  InvalidFileIdError,
  InvalidFileInfoError,
  InvalidFileNameError,
  InvalidPartNumberError,
  MethodNotAllowedError,
  NetworkError,
  NotFoundError,
  OutOfRangeError,
  RangeNotSatisfiableError,
  RequestTimeoutError,
  ServiceUnavailableError,
  TooManyBucketsError,
  TooManyFilesError,
  TooManyRequestsError,
} from './errors/index.ts'
export type { RetryOptions } from './http/retry.ts'
export type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  RetryTransportOptions,
} from './http/transport.ts'
export { FetchTransport, RetryTransport } from './http/transport.ts'
export { deriveAllowedSuffixes, UrlGuard } from './http/url-guard.ts'
export { B2Object, type DownloadCallOptions, type HeadCallOptions } from './object.ts'
export {
  type DownloadFileOptions,
  RawClient,
  type RawClientOptions,
  type SseCDownloadKey,
} from './raw/index.ts'
export { IncrementalSha1, sha1Hex } from './streams/hash.ts'
export type { ProgressEvent, ProgressListener } from './streams/progress.ts'
export type { ContentSource } from './streams/source.ts'
export { BlobSource, BufferSource, StreamSource, toContentSource } from './streams/source.ts'
export { Capability } from './types/auth.ts'
// Named-constant enum objects paired with the string-literal type aliases.
// These give users IDE autocomplete and typo protection
// (`BucketType.AllPrivate` instead of `'allPrivate'`) without breaking the
// existing string-literal call sites. Each export here has a matching type
// of the same name forwarded by the `export type *` line below.
export { BucketRetentionMode, BucketType, CorsOperation } from './types/bucket.ts'
export {
  EncryptionAlgorithm,
  EncryptionKey,
  EncryptionMode,
  SSE_B2,
  SSE_NONE,
  sseCustomer,
} from './types/encryption.ts'
export { KNOWN_B2_ERROR_CODES } from './types/errors.ts'
export { FileAction, MetadataDirective } from './types/file.ts'
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
export type * from './types/index.ts'
export { LegalHoldValue, RetentionMode } from './types/lock.ts'
export { EventType } from './types/notifications.ts'
export type { UploadRetryEvent, UploadRetryListener } from './upload/retry.ts'
export type { UploadWriteHandle } from './upload/stream.ts'
export type { PageFetcher, PaginatorOptions } from './util/paginator.ts'
// Generic pagination helpers. Most callers want the `paginateX()` method
// on `Bucket` / `B2Client`; these are the underlying building blocks for
// paginating raw endpoints or composing custom iteration shapes.
export { paginateItems, paginatePages } from './util/paginator.ts'

export { VERSION } from './version.ts'
