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

export interface B2ErrorResponse {
  readonly status: number
  readonly code: B2ErrorCode
  readonly message: string
}
