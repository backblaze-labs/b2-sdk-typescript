import { describe, expect, it } from 'vitest'

import {
  type B2ErrorResponse,
  KNOWN_B2_ERROR_CODES,
  type KnownB2ErrorCode,
} from '../types/errors.ts'

import {
  AccessDeniedError,
  B2Error,
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
  InvalidFileIdError,
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
} from './index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides: Partial<B2ErrorResponse> = {}): B2ErrorResponse {
  return {
    status: overrides.status ?? 400,
    code: overrides.code ?? 'bad_request',
    message: overrides.message ?? 'Test error message',
  }
}

type B2ErrorClass = new (
  response: B2ErrorResponse,
  options?: ConstructorParameters<typeof B2Error>[1],
) => B2Error

// ---------------------------------------------------------------------------
// B2Error base class
// ---------------------------------------------------------------------------

describe('B2Error', () => {
  it('stores status, code, and message from the response', () => {
    const res = makeResponse({ status: 401, code: 'bad_auth_token', message: 'Unauthorized' })
    const err = new B2Error(res)

    expect(err.status).toBe(401)
    expect(err.code).toBe('bad_auth_token')
    expect(err.message).toBe('Unauthorized')
    expect(err.name).toBe('B2Error')
  })

  it('computes retryable as true for transient status codes', () => {
    expect(new B2Error(makeResponse({ status: 408, code: 'request_timeout' })).retryable).toBe(true)
    expect(new B2Error(makeResponse({ status: 429, code: 'too_many_requests' })).retryable).toBe(
      true,
    )
    expect(new B2Error(makeResponse({ status: 503, code: 'service_unavailable' })).retryable).toBe(
      true,
    )
    // Transient 5xx: 500 (internal_error), 502, 504 are retryable. The 502/504
    // cases use the default non-transient `bad_request` code to prove the
    // retry decision is status-based, not code-based.
    expect(new B2Error(makeResponse({ status: 500, code: 'internal_error' })).retryable).toBe(true)
    expect(new B2Error(makeResponse({ status: 502 })).retryable).toBe(true)
    expect(new B2Error(makeResponse({ status: 504 })).retryable).toBe(true)
  })

  it('computes retryable as true for expired_auth_token regardless of status', () => {
    const err = new B2Error(makeResponse({ status: 401, code: 'expired_auth_token' }))
    expect(err.retryable).toBe(true)
  })

  it('computes retryable as false for non-transient errors', () => {
    expect(new B2Error(makeResponse({ status: 400, code: 'bad_request' })).retryable).toBe(false)
    expect(new B2Error(makeResponse({ status: 403, code: 'access_denied' })).retryable).toBe(false)
    expect(new B2Error(makeResponse({ status: 404, code: 'file_not_present' })).retryable).toBe(
      false,
    )
    // 501 Not Implemented is deterministic, not transient: never retried.
    expect(new B2Error(makeResponse({ status: 501 })).retryable).toBe(false)
    // Regression guard: RetryTransport synthesizes `code: 'internal_error'` for
    // any error body that isn't parseable JSON (e.g. a bodyless 404 download
    // miss). The retry decision must be status-based, so a 404 carrying that
    // synthetic code is NOT retryable — otherwise missing-file downloads would
    // retry until timeout.
    expect(new B2Error(makeResponse({ status: 404, code: 'internal_error' })).retryable).toBe(false)
  })

  it('stores requestId when provided in options', () => {
    const err = new B2Error(makeResponse(), { requestId: 'req-abc-123' })
    expect(err.requestId).toBe('req-abc-123')
  })

  it('stores retryAfter when provided in options', () => {
    const err = new B2Error(makeResponse(), { retryAfter: 5 })
    expect(err.retryAfter).toBe(5)
  })

  it('leaves requestId undefined when not provided', () => {
    const err = new B2Error(makeResponse())
    expect(err.requestId).toBeUndefined()
  })

  it('leaves retryAfter undefined when not provided', () => {
    const err = new B2Error(makeResponse())
    expect(err.retryAfter).toBeUndefined()
  })

  it('extends Error', () => {
    const err = new B2Error(makeResponse())
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// Subclass tests
// ---------------------------------------------------------------------------

describe('ExpiredAuthTokenError', () => {
  const res = makeResponse({ status: 401, code: 'expired_auth_token', message: 'Token expired' })

  it('extends B2Error', () => {
    expect(new ExpiredAuthTokenError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to ExpiredAuthTokenError', () => {
    expect(new ExpiredAuthTokenError(res).name).toBe('ExpiredAuthTokenError')
  })

  it('is retryable', () => {
    expect(new ExpiredAuthTokenError(res).retryable).toBe(true)
  })

  it('is detected by instanceof', () => {
    const err = new ExpiredAuthTokenError(res)
    expect(err instanceof ExpiredAuthTokenError).toBe(true)
    expect(err instanceof B2Error).toBe(true)
    expect(err instanceof Error).toBe(true)
  })
})

describe('BadAuthTokenError', () => {
  const res = makeResponse({ status: 401, code: 'bad_auth_token', message: 'Bad token' })

  it('extends B2Error', () => {
    expect(new BadAuthTokenError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to BadAuthTokenError', () => {
    expect(new BadAuthTokenError(res).name).toBe('BadAuthTokenError')
  })

  it('is not retryable', () => {
    expect(new BadAuthTokenError(res).retryable).toBe(false)
  })
})

describe('ServiceUnavailableError', () => {
  const res = makeResponse({ status: 503, code: 'service_unavailable', message: 'Try again' })

  it('extends B2Error', () => {
    expect(new ServiceUnavailableError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to ServiceUnavailableError', () => {
    expect(new ServiceUnavailableError(res).name).toBe('ServiceUnavailableError')
  })

  it('is retryable', () => {
    expect(new ServiceUnavailableError(res).retryable).toBe(true)
  })

  it('accepts retryAfter option', () => {
    const err = new ServiceUnavailableError(res, { retryAfter: 10 })
    expect(err.retryAfter).toBe(10)
  })
})

describe('RequestTimeoutError', () => {
  const res = makeResponse({ status: 408, code: 'request_timeout', message: 'Timed out' })

  it('extends B2Error', () => {
    expect(new RequestTimeoutError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to RequestTimeoutError', () => {
    expect(new RequestTimeoutError(res).name).toBe('RequestTimeoutError')
  })

  it('is retryable', () => {
    expect(new RequestTimeoutError(res).retryable).toBe(true)
  })
})

describe('TooManyRequestsError', () => {
  const res = makeResponse({ status: 429, code: 'too_many_requests', message: 'Slow down' })

  it('extends B2Error', () => {
    expect(new TooManyRequestsError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to TooManyRequestsError', () => {
    expect(new TooManyRequestsError(res).name).toBe('TooManyRequestsError')
  })

  it('is retryable', () => {
    expect(new TooManyRequestsError(res).retryable).toBe(true)
  })

  it('accepts retryAfter option', () => {
    const err = new TooManyRequestsError(res, { retryAfter: 30 })
    expect(err.retryAfter).toBe(30)
  })
})

describe('CapExceededError', () => {
  const res = makeResponse({ status: 403, code: 'cap_exceeded', message: 'Cap exceeded' })

  it('extends B2Error', () => {
    expect(new CapExceededError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to CapExceededError', () => {
    expect(new CapExceededError(res).name).toBe('CapExceededError')
  })

  it('is not retryable', () => {
    expect(new CapExceededError(res).retryable).toBe(false)
  })
})

describe('AccessDeniedError', () => {
  const res = makeResponse({ status: 403, code: 'access_denied', message: 'Forbidden' })

  it('extends B2Error', () => {
    expect(new AccessDeniedError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to AccessDeniedError', () => {
    expect(new AccessDeniedError(res).name).toBe('AccessDeniedError')
  })

  it('is not retryable', () => {
    expect(new AccessDeniedError(res).retryable).toBe(false)
  })
})

describe('FileNotPresentError', () => {
  const res = makeResponse({ status: 404, code: 'file_not_present', message: 'Not found' })

  it('extends B2Error', () => {
    expect(new FileNotPresentError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to FileNotPresentError', () => {
    expect(new FileNotPresentError(res).name).toBe('FileNotPresentError')
  })

  it('is not retryable', () => {
    expect(new FileNotPresentError(res).retryable).toBe(false)
  })
})

describe('DuplicateBucketNameError', () => {
  const res = makeResponse({
    status: 400,
    code: 'duplicate_bucket_name',
    message: 'Bucket already exists',
  })

  it('extends B2Error', () => {
    expect(new DuplicateBucketNameError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to DuplicateBucketNameError', () => {
    expect(new DuplicateBucketNameError(res).name).toBe('DuplicateBucketNameError')
  })

  it('is not retryable', () => {
    expect(new DuplicateBucketNameError(res).retryable).toBe(false)
  })
})

describe('BadRequestError', () => {
  const res = makeResponse({ status: 400, code: 'bad_request', message: 'Invalid parameter' })

  it('extends B2Error', () => {
    expect(new BadRequestError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to BadRequestError', () => {
    expect(new BadRequestError(res).name).toBe('BadRequestError')
  })

  it('is not retryable', () => {
    expect(new BadRequestError(res).retryable).toBe(false)
  })
})

describe('BadUploadUrlError', () => {
  const res = makeResponse({ status: 400, code: 'bad_request', message: 'Upload URL expired' })

  it('extends B2Error', () => {
    expect(new BadUploadUrlError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to BadUploadUrlError', () => {
    expect(new BadUploadUrlError(res).name).toBe('BadUploadUrlError')
  })

  it('is not retryable', () => {
    expect(new BadUploadUrlError(res).retryable).toBe(false)
  })
})

describe('ChecksumMismatchError', () => {
  const res = makeResponse({
    status: 400,
    code: 'bad_sha1_checksum',
    message: 'Checksum mismatch',
  })

  it('extends B2Error', () => {
    expect(new ChecksumMismatchError(res)).toBeInstanceOf(B2Error)
  })

  it('sets name to ChecksumMismatchError', () => {
    expect(new ChecksumMismatchError(res).name).toBe('ChecksumMismatchError')
  })

  it('is not retryable', () => {
    expect(new ChecksumMismatchError(res).retryable).toBe(false)
  })
})

const newSubclassCases = [
  {
    label: 'InternalError',
    ctor: InternalError,
    response: makeResponse({ status: 500, code: 'internal_error' }),
    retryable: true,
  },
  {
    label: 'TooManyBucketsError',
    ctor: TooManyBucketsError,
    response: makeResponse({ status: 400, code: 'too_many_buckets' }),
    retryable: false,
  },
  {
    label: 'TooManyFilesError',
    ctor: TooManyFilesError,
    response: makeResponse({ status: 400, code: 'too_many_files' }),
    retryable: false,
  },
  {
    label: 'NotFoundError',
    ctor: NotFoundError,
    response: makeResponse({ status: 404, code: 'not_found' }),
    retryable: false,
  },
  {
    label: 'BadBucketIdError',
    ctor: BadBucketIdError,
    response: makeResponse({ status: 400, code: 'bad_bucket_id' }),
    retryable: false,
  },
  {
    label: 'MethodNotAllowedError',
    ctor: MethodNotAllowedError,
    response: makeResponse({ status: 405, code: 'method_not_allowed' }),
    retryable: false,
  },
  {
    label: 'ConflictError',
    ctor: ConflictError,
    response: makeResponse({ status: 409, code: 'conflict' }),
    retryable: false,
  },
  {
    label: 'BadJsonError',
    ctor: BadJsonError,
    response: makeResponse({ status: 400, code: 'bad_json' }),
    retryable: false,
  },
  {
    label: 'InvalidBucketIdError',
    ctor: InvalidBucketIdError,
    response: makeResponse({ status: 400, code: 'invalid_bucket_id' }),
    retryable: false,
  },
  {
    label: 'OutOfRangeError',
    ctor: OutOfRangeError,
    response: makeResponse({ status: 400, code: 'out_of_range' }),
    retryable: false,
  },
  {
    label: 'RangeNotSatisfiableError',
    ctor: RangeNotSatisfiableError,
    response: makeResponse({ status: 416, code: 'range_not_satisfiable' }),
    retryable: false,
  },
  {
    label: 'InvalidFileIdError',
    ctor: InvalidFileIdError,
    response: makeResponse({ status: 400, code: 'invalid_file_id' }),
    retryable: false,
  },
  {
    label: 'InvalidPartNumberError',
    ctor: InvalidPartNumberError,
    response: makeResponse({ status: 400, code: 'invalid_part_number' }),
    retryable: false,
  },
] satisfies Array<{
  label: string
  ctor: B2ErrorClass
  response: B2ErrorResponse
  retryable: boolean
}>

describe.each(newSubclassCases)('$label', ({ label, ctor, response, retryable }) => {
  it('extends B2Error', () => {
    expect(new ctor(response)).toBeInstanceOf(B2Error)
  })

  it('sets name to the subclass name', () => {
    expect(new ctor(response).name).toBe(label)
  })

  it('sets the retryable contract', () => {
    expect(new ctor(response).retryable).toBe(retryable)
  })

  it('passes through request and retry metadata', () => {
    const err = new ctor(response, { requestId: 'req-new-subclass', retryAfter: 9 })

    expect(err.requestId).toBe('req-new-subclass')
    expect(err.retryAfter).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// NetworkError
// ---------------------------------------------------------------------------

describe('NetworkError', () => {
  it('extends Error (not B2Error)', () => {
    const err = new NetworkError('Connection refused')
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(B2Error)
  })

  it('sets message', () => {
    const err = new NetworkError('DNS lookup failed')
    expect(err.message).toBe('DNS lookup failed')
  })

  it('sets name to NetworkError', () => {
    const err = new NetworkError('timeout')
    expect(err.name).toBe('NetworkError')
  })

  it('is always retryable', () => {
    const err = new NetworkError('ECONNRESET')
    expect(err.retryable).toBe(true)
  })

  it('stores the cause when provided', () => {
    const original = new TypeError('fetch failed')
    const err = new NetworkError('Network failure', original)
    expect(err.cause).toBe(original)
  })

  it('leaves cause undefined when not provided', () => {
    const err = new NetworkError('Connection refused')
    expect(err.cause).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  describe('code-based classification', () => {
    const classificationCases = {
      expired_auth_token: { status: 401, ctor: ExpiredAuthTokenError },
      bad_auth_token: { status: 401, ctor: BadAuthTokenError },
      unauthorized: { status: 401, ctor: BadAuthTokenError },
      bad_request: { status: 400, ctor: BadRequestError },
      bad_bucket_id: { status: 400, ctor: BadBucketIdError },
      not_found: { status: 404, ctor: NotFoundError },
      method_not_allowed: { status: 405, ctor: MethodNotAllowedError },
      request_timeout: { status: 408, ctor: RequestTimeoutError },
      conflict: { status: 409, ctor: ConflictError },
      duplicate_bucket_name: { status: 400, ctor: DuplicateBucketNameError },
      too_many_buckets: { status: 400, ctor: TooManyBucketsError },
      too_many_files: { status: 400, ctor: TooManyFilesError },
      cap_exceeded: { status: 403, ctor: CapExceededError },
      storage_cap_exceeded: { status: 403, ctor: CapExceededError },
      transaction_cap_exceeded: { status: 403, ctor: CapExceededError },
      access_denied: { status: 403, ctor: AccessDeniedError },
      service_unavailable: { status: 503, ctor: ServiceUnavailableError },
      internal_error: { status: 500, ctor: InternalError },
      bad_json: { status: 400, ctor: BadJsonError },
      invalid_bucket_id: { status: 400, ctor: InvalidBucketIdError },
      file_not_present: { status: 404, ctor: FileNotPresentError },
      no_such_file: { status: 404, ctor: FileNotPresentError },
      out_of_range: { status: 400, ctor: OutOfRangeError },
      range_not_satisfiable: { status: 416, ctor: RangeNotSatisfiableError },
      invalid_file_id: { status: 400, ctor: InvalidFileIdError },
      invalid_part_number: { status: 400, ctor: InvalidPartNumberError },
      bad_sha1_checksum: { status: 400, ctor: ChecksumMismatchError },
      download_cap_exceeded: { status: 403, ctor: CapExceededError },
    } satisfies Record<KnownB2ErrorCode, { status: number; ctor: B2ErrorClass }>

    const classificationEntries = KNOWN_B2_ERROR_CODES.map(
      (code) => [code, classificationCases[code]] as const,
    )

    it('has a classification case for every known B2 error code', () => {
      expect(Object.keys(classificationCases).sort()).toEqual([...KNOWN_B2_ERROR_CODES].sort())
    })

    it.each(classificationEntries)('maps %s to a specific subclass', (code, { status, ctor }) => {
      const res = makeResponse({ status, code })
      const err = classifyError(res)

      expect(err).toBeInstanceOf(ctor)
      expect(err.constructor).not.toBe(B2Error)
    })
  })

  describe('status-based fallback', () => {
    it('maps status 429 with unknown code to TooManyRequestsError', () => {
      const res = makeResponse({ status: 429, code: 'some_unknown_code' })
      expect(classifyError(res)).toBeInstanceOf(TooManyRequestsError)
    })

    it('maps status 503 with unknown code to ServiceUnavailableError', () => {
      const res = makeResponse({ status: 503, code: 'some_unknown_code' })
      expect(classifyError(res)).toBeInstanceOf(ServiceUnavailableError)
    })

    it('maps status 408 with unknown code to RequestTimeoutError', () => {
      const res = makeResponse({ status: 408, code: 'some_unknown_code' })
      expect(classifyError(res)).toBeInstanceOf(RequestTimeoutError)
    })
  })

  describe('unknown codes', () => {
    it('falls back to B2Error for an unrecognized code and status', () => {
      const res = makeResponse({ status: 500, code: 'some_unknown_code', message: 'Server error' })
      const err = classifyError(res)
      expect(err).toBeInstanceOf(B2Error)
      expect(err).not.toBeInstanceOf(BadRequestError)
      expect(err.constructor).toBe(B2Error)
    })

    it('preserves status, code, and message on the fallback B2Error', () => {
      const res = makeResponse({ status: 500, code: 'some_unknown_code', message: 'Oops' })
      const err = classifyError(res)
      expect(err.status).toBe(500)
      expect(err.code).toBe('some_unknown_code')
      expect(err.message).toBe('Oops')
    })
  })

  describe('extra options pass-through', () => {
    it('passes retryAfter through to the constructed error', () => {
      const res = makeResponse({ status: 503, code: 'service_unavailable' })
      const err = classifyError(res, { retryAfter: 15 })
      expect(err.retryAfter).toBe(15)
    })

    it('passes requestId through to the constructed error', () => {
      const res = makeResponse({ status: 401, code: 'expired_auth_token' })
      const err = classifyError(res, { requestId: 'req-xyz-789' })
      expect(err.requestId).toBe('req-xyz-789')
    })

    it('passes both retryAfter and requestId together', () => {
      const res = makeResponse({ status: 429, code: 'some_unknown_code' })
      const err = classifyError(res, { retryAfter: 60, requestId: 'req-000' })
      expect(err.retryAfter).toBe(60)
      expect(err.requestId).toBe('req-000')
    })

    it('works without options (defaults to no retryAfter or requestId)', () => {
      const res = makeResponse({ status: 400, code: 'bad_request' })
      const err = classifyError(res)
      expect(err.retryAfter).toBeUndefined()
      expect(err.requestId).toBeUndefined()
    })
  })
})
