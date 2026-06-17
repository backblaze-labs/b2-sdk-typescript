/**
 * B2 API error codes documented by the SDK.
 * This list drives `KnownB2ErrorCode`; `B2ErrorCode` adds a string fallback
 * so callers can receive unknown future server codes while keeping autocomplete
 * for known values.
 */
export const KNOWN_B2_ERROR_CODES = [
  'expired_auth_token',
  'bad_auth_token',
  'unauthorized',
  'bad_request',
  'bad_bucket_name',
  'bad_bucket_id',
  'not_found',
  'method_not_allowed',
  'request_timeout',
  'too_many_requests',
  'conflict',
  'duplicate_bucket_name',
  'too_many_buckets',
  'too_many_files',
  'cap_exceeded',
  'storage_cap_exceeded',
  'transaction_cap_exceeded',
  'download_cap_exceeded',
  'access_denied',
  'service_unavailable',
  'internal_error',
  'bad_json',
  'invalid_bucket_id',
  'invalid_bucket_name',
  'invalid_bucket_info',
  'file_not_present',
  'no_such_file',
  'out_of_range',
  'range_not_satisfiable',
  'invalid_file_id',
  'invalid_file_name',
  'invalid_file_info',
  'invalid_part_number',
  'bad_sha1_checksum',
] as const

/** B2 error codes documented by the SDK and classified exhaustively. */
export type KnownB2ErrorCode = (typeof KNOWN_B2_ERROR_CODES)[number]

/**
 * B2 API error code value.
 * Known codes are enumerated for autocomplete; unknown future server codes are
 * still accepted as strings.
 */
export type B2ErrorCode = KnownB2ErrorCode | (string & {})

/** Standard error response body returned by the B2 API on failure. */
export interface B2ErrorResponse {
  /** HTTP status code from the B2 API response. */
  readonly status: number
  /** Machine-readable error code identifying the specific failure. */
  readonly code: B2ErrorCode
  /** Human-readable description of the error. */
  readonly message: string
}
