/**
 * Known B2 API error codes.
 * The union includes a `string & {}` fallback to allow unknown error codes
 * while still providing autocomplete for well-known values.
 */
export type B2ErrorCode =
  | 'expired_auth_token'
  | 'bad_auth_token'
  | 'unauthorized'
  | 'bad_request'
  | 'bad_bucket_id'
  | 'not_found'
  | 'method_not_allowed'
  | 'request_timeout'
  | 'conflict'
  | 'duplicate_bucket_name'
  | 'too_many_buckets'
  | 'too_many_files'
  | 'cap_exceeded'
  | 'storage_cap_exceeded'
  | 'transaction_cap_exceeded'
  | 'access_denied'
  | 'service_unavailable'
  | 'internal_error'
  | 'bad_json'
  | 'invalid_bucket_id'
  | 'file_not_present'
  | 'no_such_file'
  | 'out_of_range'
  | 'range_not_satisfiable'
  | 'invalid_file_id'
  | 'invalid_part_number'
  | 'bad_sha1_checksum'
  | 'download_cap_exceeded'
  | (string & {})

/** Standard error response body returned by the B2 API on failure. */
export interface B2ErrorResponse {
  /** HTTP status code from the B2 API response. */
  readonly status: number
  /** Machine-readable error code identifying the specific failure. */
  readonly code: B2ErrorCode
  /** Human-readable description of the error. */
  readonly message: string
}
