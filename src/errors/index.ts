/**
 * Typed error hierarchy for B2 API failures.
 *
 * Every B2 error response is mapped to a specific {@link B2Error} subclass
 * (e.g. {@link ExpiredAuthTokenError}, {@link CapExceededError}) with pre-computed
 * {@link B2Error.retryable | retryable} flags. Use {@link classifyError} to convert
 * a raw error response into the appropriate subclass.
 *
 * @packageDocumentation
 */

import type { B2ErrorCode, B2ErrorResponse } from '../types/errors.js'

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
  constructor(response: B2ErrorResponse, options?: { retryAfter?: number; requestId?: string }) {
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
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'ExpiredAuthTokenError'
  }
}

/** Thrown when the auth token is invalid or unauthorized. */
export class BadAuthTokenError extends B2Error {
  /**
   * Creates a new BadAuthTokenError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadAuthTokenError'
  }
}

/** Thrown when the B2 service is temporarily unavailable (HTTP 503). */
export class ServiceUnavailableError extends B2Error {
  /**
   * Creates a new ServiceUnavailableError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { retryAfter?: number; requestId?: string }) {
    super(response, options)
    this.name = 'ServiceUnavailableError'
  }
}

/** Thrown when a request times out on the server side (HTTP 408). */
export class RequestTimeoutError extends B2Error {
  /**
   * Creates a new RequestTimeoutError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'RequestTimeoutError'
  }
}

/** Thrown when the client has sent too many requests (HTTP 429). */
export class TooManyRequestsError extends B2Error {
  /**
   * Creates a new TooManyRequestsError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { retryAfter?: number; requestId?: string }) {
    super(response, options)
    this.name = 'TooManyRequestsError'
  }
}

/** Thrown when a storage, transaction, or download cap has been exceeded. */
export class CapExceededError extends B2Error {
  /**
   * Creates a new CapExceededError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'CapExceededError'
  }
}

/** Thrown when the application key does not have permission for the requested operation. */
export class AccessDeniedError extends B2Error {
  /**
   * Creates a new AccessDeniedError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'AccessDeniedError'
  }
}

/** Thrown when the requested file does not exist. */
export class FileNotPresentError extends B2Error {
  /**
   * Creates a new FileNotPresentError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'FileNotPresentError'
  }
}

/** Thrown when creating a bucket with a name that already exists in the account. */
export class DuplicateBucketNameError extends B2Error {
  /**
   * Creates a new DuplicateBucketNameError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'DuplicateBucketNameError'
  }
}

/** Thrown for general bad request errors (HTTP 400) not covered by a more specific subclass. */
export class BadRequestError extends B2Error {
  /**
   * Creates a new BadRequestError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadRequestError'
  }
}

/** Thrown when an upload URL is no longer valid and must be refreshed. */
export class BadUploadUrlError extends B2Error {
  /**
   * Creates a new BadUploadUrlError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadUploadUrlError'
  }
}

/** Thrown when the uploaded file's SHA-1 checksum does not match the expected value. */
export class ChecksumMismatchError extends B2Error {
  /**
   * Creates a new ChecksumMismatchError instance.
   * @param response - Parsed B2 error response body.
   */
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'ChecksumMismatchError'
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
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'NetworkError'
  }
}

function isTransient(status: number, code: B2ErrorCode): boolean {
  if (status === 408 || status === 429 || status === 503) return true
  if (code === 'expired_auth_token') return true
  if (code === 'service_unavailable' || code === 'request_timeout') return true
  return false
}

/**
 * Maps a B2 error response to the appropriate {@link B2Error} subclass.
 * Uses the error code for exact matching, then falls back to HTTP status codes.
 *
 * @param response - Parsed B2 error response body.
 * @param options - Optional retry and request metadata from response headers.
 *
 * @returns A typed B2Error subclass instance.
 */
export function classifyError(
  response: B2ErrorResponse,
  options?: { retryAfter?: number; requestId?: string },
): B2Error {
  switch (response.code) {
    case 'expired_auth_token':
      return new ExpiredAuthTokenError(response, options)
    case 'bad_auth_token':
    case 'unauthorized':
      return new BadAuthTokenError(response, options)
    case 'service_unavailable':
      return new ServiceUnavailableError(response, options)
    case 'request_timeout':
      return new RequestTimeoutError(response, options)
    case 'cap_exceeded':
    case 'storage_cap_exceeded':
    case 'transaction_cap_exceeded':
    case 'download_cap_exceeded':
      return new CapExceededError(response, options)
    case 'access_denied':
      return new AccessDeniedError(response, options)
    case 'file_not_present':
    case 'no_such_file':
      return new FileNotPresentError(response, options)
    case 'duplicate_bucket_name':
      return new DuplicateBucketNameError(response, options)
    case 'bad_sha1_checksum':
      return new ChecksumMismatchError(response, options)
    case 'bad_request':
      return new BadRequestError(response, options)
    default:
      break
  }

  if (response.status === 429) return new TooManyRequestsError(response, options)
  if (response.status === 503) return new ServiceUnavailableError(response, options)
  if (response.status === 408) return new RequestTimeoutError(response, options)

  return new B2Error(response, options)
}
