/**
 * Typed error hierarchy for B2 API failures.
 *
 * Every B2 error response maps to a specific {@link B2Error} subclass.
 * Retry behavior is exposed through {@link B2Error.retryable}.
 * Examples include {@link ExpiredAuthTokenError} and {@link CapExceededError}.
 * Use {@link classifyError} to convert a raw error response into the
 * appropriate subclass.
 *
 * Convention: most `B2Error` subclasses represent failures returned by the B2
 * API. The client-side exception is {@link B2RealmConfigurationError}; it
 * extends `B2Error` so realm-validation failures can be handled with the SDK
 * error hierarchy before credentials are sent.
 *
 * Other programming errors and SDK preconditions, such as "not yet authorized",
 * "stream consumed twice", or "called before init", use the native `Error`
 * constructor instead. The direct `Error` outliers are
 * {@link B2InsufficientCapabilityError}, {@link B2RedirectError},
 * {@link B2SsrfError}, {@link NetworkError}, and
 * {@link ResumeFileIdMismatchError}.
 *
 * @packageDocumentation
 */

import { redactUrlForError } from '../internal/url-redaction.ts'
import {
  type B2ErrorCode,
  type B2ErrorResponse,
  KNOWN_B2_ERROR_CODES,
  type KnownB2ErrorCode,
} from '../types/errors.ts'
import type { LargeFileId } from '../types/ids.ts'

/** Thrown when an explicit resumeFileId is not compatible with the requested upload. */
export class ResumeFileIdMismatchError extends Error {
  /** Caller-supplied unfinished large file ID that failed verification. */
  readonly fileId: LargeFileId
  /** Requested destination file name. */
  readonly fileName: string

  /**
   * Creates a new resume-file ID mismatch error.
   * @param fileId - Caller-supplied unfinished large file ID that failed verification.
   * @param fileName - Requested destination file name.
   */
  constructor(fileId: LargeFileId, fileName: string) {
    super(
      `uploadLargeFile: resumeFileId ${fileId} does not identify a compatible unfinished large file for ${fileName}.`,
    )
    this.name = 'ResumeFileIdMismatchError'
    this.fileId = fileId
    this.fileName = fileName
  }
}

/** Metadata captured from B2 error response headers. */
export interface B2ErrorOptions {
  /** Retry delay in seconds from the `Retry-After` response header, if present. */
  readonly retryAfter?: number
  /** B2 request ID from the `X-Bz-Request-Id` response header, if present. */
  readonly requestId?: string
}

/**
 * Base error class for all B2 API errors.
 * Contains the HTTP status, B2 error code, and retry metadata from the response.
 */
export class B2Error extends Error {
  /** HTTP status code returned by the B2 API. */
  readonly status: number
  /** B2 error code identifying the error type (e.g. `expired_auth_token`). */
  readonly code: B2ErrorCode
  /** B2 request ID from the `X-Bz-Request-Id` response header, if present. */
  readonly requestId?: string
  /** Retry delay in seconds from the `Retry-After` response header, if present. */
  readonly retryAfter?: number
  /** Whether this error is transient and the request can be retried. */
  readonly retryable: boolean

  /**
   * Creates a new B2Error instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional retry and request metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response.message)
    this.name = 'B2Error'
    this.status = response.status
    this.code = response.code
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter
    if (options?.requestId !== undefined) this.requestId = options.requestId
    this.retryable = isTransient(response.status, response.code)
  }
}

/** Thrown when the auth token has expired. Triggers automatic re-authorization. */
export class ExpiredAuthTokenError extends B2Error {
  /**
   * Creates a new ExpiredAuthTokenError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'ExpiredAuthTokenError'
  }
}

/** Thrown when the auth token is invalid or unauthorized. */
export class BadAuthTokenError extends B2Error {
  /**
   * Creates a new BadAuthTokenError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'BadAuthTokenError'
  }
}

/** Thrown when the B2 service is temporarily unavailable (HTTP 503). */
export class ServiceUnavailableError extends B2Error {
  /**
   * Creates a new ServiceUnavailableError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'ServiceUnavailableError'
  }
}

/** Thrown when B2 reports an internal server error. */
export class InternalError extends B2Error {
  /**
   * Creates a new InternalError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InternalError'
  }
}

/** Thrown when a request times out on the server side (HTTP 408). */
export class RequestTimeoutError extends B2Error {
  /**
   * Creates a new RequestTimeoutError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'RequestTimeoutError'
  }
}

/** Thrown when the client has sent too many requests (HTTP 429). */
export class TooManyRequestsError extends B2Error {
  /**
   * Creates a new TooManyRequestsError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'TooManyRequestsError'
  }
}

/** Thrown when the account has reached the maximum number of buckets. */
export class TooManyBucketsError extends B2Error {
  /**
   * Creates a new TooManyBucketsError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'TooManyBucketsError'
  }
}

/** Thrown when the bucket or request has reached the maximum number of files. */
export class TooManyFilesError extends B2Error {
  /**
   * Creates a new TooManyFilesError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'TooManyFilesError'
  }
}

/** Thrown when a storage, transaction, or download cap has been exceeded. */
export class CapExceededError extends B2Error {
  /**
   * Creates a new CapExceededError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'CapExceededError'
  }
}

/** Thrown when the application key does not have permission for the requested operation. */
export class AccessDeniedError extends B2Error {
  /**
   * Creates a new AccessDeniedError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'AccessDeniedError'
  }
}

/** Thrown when the requested file does not exist. */
export class FileNotPresentError extends B2Error {
  /**
   * Creates a new FileNotPresentError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'FileNotPresentError'
  }
}

/** Thrown when a requested B2 resource does not exist. */
export class NotFoundError extends B2Error {
  /**
   * Creates a new NotFoundError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'NotFoundError'
  }
}

/** Thrown when creating a bucket with a name that already exists in the account. */
export class DuplicateBucketNameError extends B2Error {
  /**
   * Creates a new DuplicateBucketNameError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'DuplicateBucketNameError'
  }
}

/** Thrown when a bucket name is malformed, reserved, or otherwise rejected by B2. */
export class InvalidBucketNameError extends B2Error {
  /**
   * Creates a new InvalidBucketNameError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidBucketNameError'
  }
}

/** Thrown when bucket metadata fails B2 validation. */
export class InvalidBucketInfoError extends B2Error {
  /**
   * Creates a new InvalidBucketInfoError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidBucketInfoError'
  }
}

/** Thrown when a bucket ID is malformed or does not identify a valid bucket. */
export class BadBucketIdError extends B2Error {
  /**
   * Creates a new BadBucketIdError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'BadBucketIdError'
  }
}

/** Thrown when the B2 endpoint does not allow the request method. */
export class MethodNotAllowedError extends B2Error {
  /**
   * Creates a new MethodNotAllowedError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'MethodNotAllowedError'
  }
}

/** Thrown when the request conflicts with current B2 resource state. */
export class ConflictError extends B2Error {
  /**
   * Creates a new ConflictError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'ConflictError'
  }
}

/** Thrown for general bad request errors (HTTP 400) not covered by a more specific subclass. */
export class BadRequestError extends B2Error {
  /**
   * Creates a new BadRequestError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'BadRequestError'
  }
}

/** Thrown when B2 cannot parse the JSON request body. */
export class BadJsonError extends B2Error {
  /**
   * Creates a new BadJsonError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'BadJsonError'
  }
}

/** Thrown when a bucket ID has a valid shape but does not identify a usable bucket. */
export class InvalidBucketIdError extends B2Error {
  /**
   * Creates a new InvalidBucketIdError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidBucketIdError'
  }
}

/** Thrown when a numeric request parameter is outside the allowed range. */
export class OutOfRangeError extends B2Error {
  /**
   * Creates a new OutOfRangeError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'OutOfRangeError'
  }
}

/** Thrown when a requested byte range cannot be satisfied. */
export class RangeNotSatisfiableError extends B2Error {
  /**
   * Creates a new RangeNotSatisfiableError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'RangeNotSatisfiableError'
  }
}

/** Thrown when a file name is malformed or otherwise rejected by B2. */
export class InvalidFileNameError extends B2Error {
  /**
   * Creates a new InvalidFileNameError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidFileNameError'
  }
}

/** Thrown when file metadata fails B2 validation. */
export class InvalidFileInfoError extends B2Error {
  /**
   * Creates a new InvalidFileInfoError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidFileInfoError'
  }
}

/** Thrown when a file ID is malformed or does not identify a valid file. */
export class InvalidFileIdError extends B2Error {
  /**
   * Creates a new InvalidFileIdError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidFileIdError'
  }
}

/** Thrown when a multipart upload part number is invalid. */
export class InvalidPartNumberError extends B2Error {
  /**
   * Creates a new InvalidPartNumberError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'InvalidPartNumberError'
  }
}

/**
 * Thrown when an upload URL is no longer valid and must be refreshed.
 *
 * Forward-compat insurance: B2 does not currently surface a distinct
 * error code for this case, so {@link classifyError} never actually
 * instantiates this class today. It's part of the public API so
 * consumers can pre-write `instanceof` checks; when B2 documents a
 * `bad_upload_url` (or similar) error code, the `classifyError`
 * switch gets a matching case and existing consumer code starts
 * catching the typed error without any changes on their side.
 *
 * Until then, expect `BadRequestError` for upload-URL invalidation
 * scenarios — that's what B2 currently returns.
 */
export class BadUploadUrlError extends B2Error {
  /**
   * Creates a new BadUploadUrlError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'BadUploadUrlError'
  }
}

/**
 * Thrown when the uploaded file's SHA-1 checksum does not match the
 * expected value.
 *
 * When B2 returns `bad_sha1_checksum`, {@link classifyError} instantiates
 * this class so callers can handle checksum failures with `instanceof`.
 * Generic `bad_request` checksum failures continue to classify as
 * {@link BadRequestError}.
 */
export class ChecksumMismatchError extends B2Error {
  /**
   * Creates a new ChecksumMismatchError instance.
   * @param response - Parsed B2 error response body.
   * @param options - Optional metadata from response headers.
   */
  constructor(response: B2ErrorResponse, options?: B2ErrorOptions) {
    super(response, options)
    this.name = 'ChecksumMismatchError'
  }
}

/**
 * Thrown by client-side capability checks when the application key is missing
 * capabilities required by an operation. Not raised by the server.
 */
export class B2InsufficientCapabilityError extends Error {
  /** Capabilities that were required for the operation. */
  readonly required: readonly string[]
  /** Capabilities that the current key actually has. */
  readonly available: readonly string[]
  /** Capabilities present in `required` but not in `available`. */
  readonly missing: readonly string[]

  /**
   * Creates a new B2InsufficientCapabilityError instance.
   *
   * @param required - Capabilities the operation requires.
   * @param available - Capabilities the current key holds.
   * @param missing - The subset of required that isn't available.
   */
  constructor(
    required: readonly string[],
    available: readonly string[],
    missing: readonly string[],
  ) {
    super(`Application key is missing capabilities: ${missing.join(', ')}`)
    this.name = 'B2InsufficientCapabilityError'
    this.required = required
    this.available = available
    this.missing = missing
  }
}

/**
 * Thrown when the SDK is asked to fetch a URL whose host is outside the
 * authorized B2 realm. Defense against SSRF / URL-substitution attacks where
 * a compromised or hostile B2 endpoint returns an upload URL pointing at an
 * internal service (e.g. cloud metadata at `169.254.169.254`).
 *
 * Not retryable.
 */
export class B2SsrfError extends Error {
  /** Always `false` — this is a security failure, not transient. */
  readonly retryable = false

  /**
   * Creates a new {@link B2SsrfError}.
   *
   * @param message - Human-readable description of which URL was rejected and why.
   * @param url - The full URL that was rejected.
   */
  constructor(
    message: string,
    /** The full URL that was rejected. */
    public readonly url: string,
  ) {
    super(message)
    this.name = 'B2SsrfError'
  }
}

/** Thrown when a configured auth realm cannot safely be used for authorization. */
export class B2RealmConfigurationError extends B2Error {
  /**
   * Creates a new B2RealmConfigurationError instance.
   *
   * @param message - Human-readable description of the invalid realm setting.
   */
  constructor(message: string) {
    super({ status: 400, code: 'bad_request', message })
    this.name = 'B2RealmConfigurationError'
  }
}

/** Thrown when the SDK refuses to follow an HTTP redirect automatically. */
export class B2RedirectError extends Error {
  /** Always `false` because a blocked redirect is deterministic. */
  readonly retryable = false
  /** Sanitized request URL whose response attempted to redirect. */
  readonly url: string
  /** HTTP redirect status code, or 0 for an opaque browser redirect. */
  readonly status: number
  /** Sanitized redirect target, or `null` when no Location header was present. */
  readonly location: string | null

  /**
   * Creates a new B2RedirectError instance.
   *
   * @param url - Request URL whose response attempted to redirect. Stored as a sanitized URL.
   * @param status - HTTP redirect status code.
   * @param location - Redirect Location header, if present. Stored as a sanitized URL.
   */
  constructor(url: string, status: number, location: string | null) {
    const safeUrl = redactUrlForError(url)
    const safeLocation = location !== null ? redactUrlForError(location, { baseUrl: url }) : null
    super(
      safeLocation !== null
        ? `HTTP ${status} redirect blocked for ${safeUrl} to ${safeLocation}`
        : `HTTP ${status} redirect blocked for ${safeUrl}`,
    )
    this.name = 'B2RedirectError'
    this.url = safeUrl
    this.status = status
    this.location = safeLocation
  }
}

/** Thrown when a network-level failure occurs (DNS, TCP, TLS). Always retryable. */
export class NetworkError extends Error {
  /** Always `true` since network errors are transient. */
  readonly retryable = true

  /**
   * Creates a new NetworkError instance.
   * @param message - Human-readable description of the network failure.
   * @param cause - The underlying error that caused this failure, if any.
   */
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'NetworkError'
  }
}

/**
 * Thrown when an upload POST returned a response but its body could not be
 * read. The upload may already have been stored by B2, so retrying this error
 * can create duplicate file versions or parts.
 */
export class UploadResponseBodyError extends Error {
  /**
   * Creates a new UploadResponseBodyError instance.
   * @param message - Human-readable description of the response read failure.
   * @param cause - The underlying response body error.
   */
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause })
    this.name = 'UploadResponseBodyError'
  }
}

function isTransient(status: number, code: B2ErrorCode): boolean {
  // Request timeout + rate limit.
  if (status === 408 || status === 429) return true
  // Transient server errors: internal error (500), bad gateway (502), service
  // unavailable (503), gateway timeout (504). B2 documents 500 and 503 as
  // retryable; 502/504 are transient infrastructure failures. 501 (Not
  // Implemented) is deliberately excluded — it is deterministic, not transient.
  //
  // This is keyed on STATUS, not on the `internal_error` code: `RetryTransport`
  // synthesizes `{ code: 'internal_error' }` for any error response whose body
  // is not parseable JSON (see transport.ts), including bodyless 4xx like a 404
  // download miss. Treating that code as transient would wrongly retry 4xx.
  if (status === 500 || status === 502 || status === 503 || status === 504) return true
  if (code === 'expired_auth_token') return true
  if (code === 'service_unavailable' || code === 'request_timeout') return true
  return false
}

const knownB2ErrorCodes: ReadonlySet<string> = new Set(KNOWN_B2_ERROR_CODES)

function isKnownB2ErrorCode(code: B2ErrorCode): code is KnownB2ErrorCode {
  return knownB2ErrorCodes.has(code)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled B2 error code: ${String(value)}`)
}

function classifyKnownError(
  response: B2ErrorResponse,
  code: KnownB2ErrorCode,
  options?: B2ErrorOptions,
): B2Error {
  switch (code) {
    case 'expired_auth_token':
      return new ExpiredAuthTokenError(response, options)
    case 'bad_auth_token':
    case 'unauthorized':
      return new BadAuthTokenError(response, options)
    case 'bad_request':
      return new BadRequestError(response, options)
    case 'bad_bucket_name':
    case 'invalid_bucket_name':
      return new InvalidBucketNameError(response, options)
    case 'bad_bucket_id':
      return new BadBucketIdError(response, options)
    case 'not_found':
      return new NotFoundError(response, options)
    case 'method_not_allowed':
      return new MethodNotAllowedError(response, options)
    case 'request_timeout':
      return new RequestTimeoutError(response, options)
    case 'too_many_requests':
      return new TooManyRequestsError(response, options)
    case 'conflict':
      return new ConflictError(response, options)
    case 'duplicate_bucket_name':
      return new DuplicateBucketNameError(response, options)
    case 'too_many_buckets':
      return new TooManyBucketsError(response, options)
    case 'too_many_files':
      return new TooManyFilesError(response, options)
    case 'cap_exceeded':
    case 'storage_cap_exceeded':
    case 'transaction_cap_exceeded':
    case 'download_cap_exceeded':
      return new CapExceededError(response, options)
    case 'access_denied':
      return new AccessDeniedError(response, options)
    case 'service_unavailable':
      return new ServiceUnavailableError(response, options)
    case 'internal_error':
      return new InternalError(response, options)
    case 'bad_json':
      return new BadJsonError(response, options)
    case 'invalid_bucket_id':
      return new InvalidBucketIdError(response, options)
    case 'invalid_bucket_info':
      return new InvalidBucketInfoError(response, options)
    case 'file_not_present':
    case 'no_such_file':
      return new FileNotPresentError(response, options)
    case 'out_of_range':
      return new OutOfRangeError(response, options)
    case 'range_not_satisfiable':
      return new RangeNotSatisfiableError(response, options)
    case 'invalid_file_id':
      return new InvalidFileIdError(response, options)
    case 'invalid_file_name':
      return new InvalidFileNameError(response, options)
    case 'invalid_file_info':
      return new InvalidFileInfoError(response, options)
    case 'invalid_part_number':
      return new InvalidPartNumberError(response, options)
    case 'bad_sha1_checksum':
      return new ChecksumMismatchError(response, options)
    default:
      return assertNever(code)
  }
}

function classifyUnknownError(response: B2ErrorResponse, options?: B2ErrorOptions): B2Error {
  if (response.status === 429) return new TooManyRequestsError(response, options)
  if (response.status === 503) return new ServiceUnavailableError(response, options)
  if (response.status === 408) return new RequestTimeoutError(response, options)

  return new B2Error(response, options)
}

/**
 * Maps a B2 error response to the appropriate {@link B2Error} subclass.
 * Uses known error codes for exact matching, then falls back to HTTP status
 * codes for unknown future B2 codes.
 *
 * Maintainer note: when B2 documents a new error code, add it to
 * `KNOWN_B2_ERROR_CODES` in `src/types/errors.ts` and add a matching
 * `classifyKnownError` switch case. Unknown codes fall through to the
 * HTTP-status-based heuristic and finally to a generic `B2Error`, which is
 * safe but loses semantic specificity (the caller can't `instanceof` against
 * a precise subclass and the retry decision relies on status alone).
 *
 * @param response - Parsed B2 error response body.
 * @param options - Optional retry and request metadata from response headers.
 *
 * @returns A typed B2Error subclass instance.
 */
export function classifyError(response: B2ErrorResponse, options?: B2ErrorOptions): B2Error {
  // `RetryTransport` and ranged-download parsing synthesize `internal_error`
  // when a non-JSON response body cannot provide a real B2 code. Only the
  // documented 500/internal_error pair should classify as InternalError.
  if (response.code === 'internal_error' && response.status !== 500) {
    return classifyUnknownError(response, options)
  }

  if (isKnownB2ErrorCode(response.code)) return classifyKnownError(response, response.code, options)

  return classifyUnknownError(response, options)
}
