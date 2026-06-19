import type { EncryptionSetting, PublicEncryptionSetting } from './encryption.ts'
import type { FileAction } from './file.ts'
import type { BucketId, LargeFileId } from './ids.ts'
import type { FileRetentionValue, LegalHoldValue } from './lock.ts'

/** Request parameters for the `b2_get_upload_url` API call. */
export interface GetUploadUrlRequest {
  /** Bucket to get an upload URL for. */
  readonly bucketId: BucketId
}

/** Response from the `b2_get_upload_url` API call. Contains a one-time upload URL and auth token. */
export interface GetUploadUrlResponse {
  /** Bucket this upload URL targets. */
  readonly bucketId: BucketId
  /** URL to POST file data to. */
  readonly uploadUrl: string
  /** Authorization token to include in the upload request. */
  readonly authorizationToken: string
}

/**
 * Headers required when uploading a file via `b2_upload_file`.
 * Sent as HTTP headers on the upload POST request.
 */
export interface UploadFileHeaders {
  /** Authorization token from `b2_get_upload_url`. */
  readonly authorization: string
  /** URL-encoded file name including path within the bucket. */
  readonly fileName: string
  /** MIME type of the file. Use `'b2/x-auto'` for automatic detection. */
  readonly contentType: string
  /** Size of the file content in bytes. */
  readonly contentLength: number
  /** SHA-1 checksum of the content, or `'hex_digits_at_end'` / `'do_not_verify'` for deferred verification. */
  readonly contentSha1: string | 'hex_digits_at_end' | 'do_not_verify'
  /** Optional user-defined key-value metadata for the file. */
  readonly fileInfo?: Record<string, string>
  /** Optional server-side encryption setting. */
  readonly serverSideEncryption?: EncryptionSetting
  /** Optional Object Lock retention for the file. */
  readonly fileRetention?: FileRetentionValue
  /** Optional legal hold for the file. */
  readonly legalHold?: LegalHoldValue
  /** Optional last-modified timestamp in milliseconds (stored as `src_last_modified_millis` in file info). */
  readonly lastModifiedMillis?: number
  /** Optional Content-Disposition header value for downloads. */
  readonly contentDisposition?: string
  /** Optional Content-Language header value for downloads. */
  readonly contentLanguage?: string
  /** Optional Expires header value for downloads. */
  readonly expires?: string
  /** Optional Cache-Control header value for downloads. */
  readonly cacheControl?: string
  /** Optional Content-Encoding header value for downloads. */
  readonly contentEncoding?: string
}

/** Request parameters for the `b2_start_large_file` API call. Initiates a multi-part upload. */
export interface StartLargeFileRequest {
  /** Bucket to upload the large file to. */
  readonly bucketId: BucketId
  /** Full path and name of the file within the bucket. */
  readonly fileName: string
  /** MIME type of the file. Use `'b2/x-auto'` for automatic detection. */
  readonly contentType: string
  /** Optional user-defined key-value metadata for the file. */
  readonly fileInfo?: Record<string, string>
  /** Optional server-side encryption setting. */
  readonly serverSideEncryption?: EncryptionSetting
  /** Optional Object Lock retention for the file. */
  readonly fileRetention?: FileRetentionValue
  /** Optional legal hold for the file. */
  readonly legalHold?: LegalHoldValue
}

/** Response from the `b2_start_large_file` API call. */
export interface StartLargeFileResponse {
  /** ID assigned to this large file upload. Use this to upload parts and finish the file. */
  readonly fileId: LargeFileId
  /** Name of the file being uploaded. */
  readonly fileName: string
  /** Account that owns this file. */
  readonly accountId: string
  /** Bucket the file is being uploaded to. */
  readonly bucketId: BucketId
  /** MIME type of the file. */
  readonly contentType: string
  /** User-defined key-value metadata stored with the file. */
  readonly fileInfo: Record<string, string>
  /** Action that created this unfinished file version. */
  readonly action?: FileAction
  /** When present, always 0 for unfinished large files. */
  readonly contentLength?: number
  /** When present, always `'none'` for unfinished large files. */
  readonly contentSha1?: string
  /** When present, always null for unfinished large files. */
  readonly contentMd5?: string | null
  /** Object Lock retention settings for this unfinished file, when readable. */
  readonly fileRetention?: {
    /** Whether the caller is authorized to read retention settings. */
    readonly isClientAuthorizedToRead: boolean
    /** Retention settings, or null when none are set or unreadable. */
    readonly value: FileRetentionValue | null
  }
  /** Legal hold status for this unfinished file, when readable. */
  readonly legalHold?: {
    /** Whether the caller is authorized to read legal hold status. */
    readonly isClientAuthorizedToRead: boolean
    /** Legal hold value, or null when none is set or unreadable. */
    readonly value: LegalHoldValue | null
  }
  /** Server-side encryption applied to this unfinished file. */
  readonly serverSideEncryption?: PublicEncryptionSetting
  /** UTC timestamp (milliseconds) when this unfinished upload was started. */
  readonly uploadTimestamp?: number
}

/** Request parameters for the `b2_get_upload_part_url` API call. */
export interface GetUploadPartUrlRequest {
  /** ID of the large file to get a part upload URL for. */
  readonly fileId: LargeFileId
}

/** Response from the `b2_get_upload_part_url` API call. Contains a one-time part upload URL and auth token. */
export interface GetUploadPartUrlResponse {
  /** ID of the large file this upload URL targets. */
  readonly fileId: LargeFileId
  /** URL to POST part data to. */
  readonly uploadUrl: string
  /** Authorization token to include in the part upload request. */
  readonly authorizationToken: string
}

/**
 * Headers required when uploading a part via `b2_upload_part`.
 * Sent as HTTP headers on the part upload POST request.
 */
export interface UploadPartHeaders {
  /** Authorization token from `b2_get_upload_part_url`. */
  readonly authorization: string
  /** Part number (1 to 10000). Parts are assembled in order to form the complete file. */
  readonly partNumber: number
  /** Size of this part in bytes. */
  readonly contentLength: number
  /** SHA-1 checksum of the part content, or `'hex_digits_at_end'` / `'do_not_verify'` for deferred verification. */
  readonly contentSha1: string | 'hex_digits_at_end' | 'do_not_verify'
  /** Optional server-side encryption setting for this part. */
  readonly serverSideEncryption?: EncryptionSetting
}

/** Response from the `b2_upload_part` API call. */
export interface UploadPartResponse {
  /** ID of the large file this part belongs to. */
  readonly fileId: LargeFileId
  /** Part number within the large file. */
  readonly partNumber: number
  /** Size of the uploaded part in bytes. */
  readonly contentLength: number
  /** SHA-1 checksum of the uploaded part content. */
  readonly contentSha1: string
  /** Server-side encryption applied to this part. */
  readonly serverSideEncryption: PublicEncryptionSetting
  /** UTC timestamp (milliseconds) when this part was uploaded. */
  readonly uploadTimestamp: number
}

/**
 * Request parameters for the `b2_finish_large_file` API call.
 * Assembles previously uploaded parts into a single complete file.
 */
export interface FinishLargeFileRequest {
  /** ID of the large file to finish. */
  readonly fileId: LargeFileId
  /** Ordered array of SHA-1 checksums, one per part, matching the upload order. */
  readonly partSha1Array: readonly string[]
}

/** Request parameters for the `b2_cancel_large_file` API call. */
export interface CancelLargeFileRequest {
  /** ID of the large file upload to cancel. */
  readonly fileId: LargeFileId
}

/** Response from the `b2_cancel_large_file` API call. */
export interface CancelLargeFileResponse {
  /** ID of the cancelled large file. */
  readonly fileId: LargeFileId
  /** Account that owned the large file. */
  readonly accountId: string
  /** Bucket the large file was being uploaded to. */
  readonly bucketId: BucketId
  /** Name of the cancelled file. */
  readonly fileName: string
}

/** Request parameters for the `b2_list_unfinished_large_files` API call. */
export interface ListUnfinishedLargeFilesRequest {
  /** Bucket to list unfinished large files from. */
  readonly bucketId: BucketId
  /** Only return files whose names start with this prefix. */
  readonly namePrefix?: string
  /** File ID to start listing from (inclusive). Used for pagination. */
  readonly startFileId?: LargeFileId
  /** Maximum number of files to return. */
  readonly maxFileCount?: number
}

/** Metadata for an in-progress large file upload that has not yet been finished or cancelled. */
export interface UnfinishedLargeFile {
  /** Action that created this unfinished file version. */
  readonly action?: FileAction
  /** ID of the large file. */
  readonly fileId: LargeFileId
  /** Name of the file. */
  readonly fileName: string
  /** Account that owns this file. */
  readonly accountId: string
  /** Bucket the file is being uploaded to. */
  readonly bucketId: BucketId
  /** MIME type of the file. */
  readonly contentType: string
  /** When present, always 0 for unfinished large files. */
  readonly contentLength?: number
  /** When present, always `'none'` for unfinished large files. */
  readonly contentSha1?: string
  /** When present, always null for unfinished large files. */
  readonly contentMd5?: string | null
  /** User-defined key-value metadata stored with the file. */
  readonly fileInfo: Record<string, string>
  /** Object Lock retention settings for this unfinished file, when readable. */
  readonly fileRetention?: {
    /** Whether the caller is authorized to read retention settings. */
    readonly isClientAuthorizedToRead: boolean
    /** Retention settings, or null when none are set or unreadable. */
    readonly value: FileRetentionValue | null
  }
  /** Legal hold status for this unfinished file, when readable. */
  readonly legalHold?: {
    /** Whether the caller is authorized to read legal hold status. */
    readonly isClientAuthorizedToRead: boolean
    /** Legal hold value, or null when none is set or unreadable. */
    readonly value: LegalHoldValue | null
  }
  /** Server-side encryption applied to this unfinished file. */
  readonly serverSideEncryption?: PublicEncryptionSetting
  /** UTC timestamp (milliseconds) when this unfinished upload was started. */
  readonly uploadTimestamp?: number
}

/** Response from the `b2_list_unfinished_large_files` API call. */
export interface ListUnfinishedLargeFilesResponse {
  /** Array of unfinished large files. */
  readonly files: readonly UnfinishedLargeFile[]
  /** Next file ID to use for pagination, or null if all files have been listed. */
  readonly nextFileId: LargeFileId | null
}

/** Request parameters for the `b2_list_parts` API call. Lists parts uploaded for a large file. */
export interface ListPartsRequest {
  /** ID of the large file to list parts for. */
  readonly fileId: LargeFileId
  /** Part number to start listing from (inclusive). Used for pagination. */
  readonly startPartNumber?: number
  /** Maximum number of parts to return. */
  readonly maxPartCount?: number
}

/** Metadata for a single uploaded part of a large file. */
export interface PartInfo {
  /** ID of the large file this part belongs to. */
  readonly fileId: LargeFileId
  /** Part number within the large file. */
  readonly partNumber: number
  /** Size of this part in bytes. */
  readonly contentLength: number
  /** SHA-1 checksum of this part's content. */
  readonly contentSha1: string
  /** UTC timestamp (milliseconds) when this part was uploaded. */
  readonly uploadTimestamp: number
}

/** Response from the `b2_list_parts` API call. */
export interface ListPartsResponse {
  /** Array of uploaded parts. */
  readonly parts: readonly PartInfo[]
  /** Next part number to use for pagination, or null if all parts have been listed. */
  readonly nextPartNumber: number | null
}
