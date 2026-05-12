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
export type { HttpTransport, HttpRequest, HttpResponse } from './http/transport.js'

export { SSE_B2, SSE_NONE, sseCustomer } from './types/encryption.js'

export type * from './types/index.js'

export { VERSION } from './version.js'
