import type { B2ErrorCode, B2ErrorResponse } from '../types/errors.js'

export class B2Error extends Error {
  readonly status: number
  readonly code: B2ErrorCode
  readonly requestId?: string
  readonly retryAfter?: number
  readonly retryable: boolean

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

export class ExpiredAuthTokenError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'ExpiredAuthTokenError'
  }
}

export class BadAuthTokenError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadAuthTokenError'
  }
}

export class ServiceUnavailableError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { retryAfter?: number; requestId?: string }) {
    super(response, options)
    this.name = 'ServiceUnavailableError'
  }
}

export class RequestTimeoutError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'RequestTimeoutError'
  }
}

export class TooManyRequestsError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { retryAfter?: number; requestId?: string }) {
    super(response, options)
    this.name = 'TooManyRequestsError'
  }
}

export class CapExceededError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'CapExceededError'
  }
}

export class AccessDeniedError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'AccessDeniedError'
  }
}

export class FileNotPresentError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'FileNotPresentError'
  }
}

export class DuplicateBucketNameError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'DuplicateBucketNameError'
  }
}

export class BadRequestError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadRequestError'
  }
}

export class BadUploadUrlError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'BadUploadUrlError'
  }
}

export class ChecksumMismatchError extends B2Error {
  constructor(response: B2ErrorResponse, options?: { requestId?: string }) {
    super(response, options)
    this.name = 'ChecksumMismatchError'
  }
}

export class NetworkError extends Error {
  readonly retryable = true

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
