import type { EncryptionSetting } from './encryption.ts'
import type { AccountId, BucketId, FileId } from './ids.ts'
import type { FileRetentionValue, LegalHoldValue } from './lock.ts'

/**
 * The action that created a file version.
 * - `'start'`: large file upload started but not yet finished.
 * - `'upload'`: file was uploaded normally.
 * - `'hide'`: file was hidden (soft-deleted).
 * - `'folder'`: virtual folder marker.
 * - `'copy'`: file was created via server-side copy.
 */
export type FileAction = 'start' | 'upload' | 'hide' | 'folder' | 'copy'

/**
 * Complete metadata for a single file version in B2.
 * Returned by `b2_get_file_info`, `b2_list_file_names`, `b2_list_file_versions`,
 * `b2_upload_file`, `b2_copy_file`, and other file-related endpoints.
 */
export interface FileVersion {
  /** Account that owns this file. */
  readonly accountId: AccountId
  /** Action that created this file version. */
  readonly action: FileAction
  /** Bucket containing this file. */
  readonly bucketId: BucketId
  /** Size of the file content in bytes. */
  readonly contentLength: number
  /** MD5 checksum of the content, or null if not available. */
  readonly contentMd5: string | null
  /** SHA-1 checksum of the content, or null if not available (e.g., large files). */
  readonly contentSha1: string | null
  /** MIME type of the file content. */
  readonly contentType: string
  /** Unique identifier for this file version. */
  readonly fileId: FileId
  /** User-defined key-value metadata stored with the file. */
  readonly fileInfo: Record<string, string>
  /** Full path and name of the file within the bucket. */
  readonly fileName: string
  /** Object Lock retention settings for this file version. */
  readonly fileRetention: {
    /** Whether the caller is authorized to read retention settings. */
    readonly isClientAuthorizedToRead: boolean
    /** Retention settings, or null if the caller lacks read authorization. */
    readonly value: FileRetentionValue | null
  }
  /** Legal hold status for this file version. */
  readonly legalHold: {
    /** Whether the caller is authorized to read legal hold status. */
    readonly isClientAuthorizedToRead: boolean
    /** Legal hold value, or null if the caller lacks read authorization. */
    readonly value: LegalHoldValue | null
  }
  /** Replication status, or null if replication is not configured. */
  readonly replicationStatus: 'pending' | 'completed' | 'failed' | 'replica' | null
  /** Server-side encryption settings applied to this file version. */
  readonly serverSideEncryption: EncryptionSetting
  /** UTC timestamp (milliseconds) when this version was uploaded. */
  readonly uploadTimestamp: number
}

/** Request parameters for the `b2_list_file_names` API call. Lists the most recent version of each file in a bucket. */
export interface ListFileNamesRequest {
  /** Bucket to list files from. */
  readonly bucketId: BucketId
  /** Return files starting after this name (exclusive). Used for pagination. */
  readonly startFileName?: string
  /** Maximum number of files to return (1 to 10000). */
  readonly maxFileCount?: number
  /** Only return files whose names start with this prefix. */
  readonly prefix?: string
  /** Delimiter for virtual folder grouping (typically `'/'`). */
  readonly delimiter?: string
}

/** Response from the `b2_list_file_names` API call. */
export interface ListFileNamesResponse {
  /** Array of file versions matching the request. */
  readonly files: readonly FileVersion[]
  /** Next file name to use for pagination, or null if all files have been listed. */
  readonly nextFileName: string | null
}

/** Request parameters for the `b2_list_file_versions` API call. Lists all versions of files in a bucket. */
export interface ListFileVersionsRequest {
  /** Bucket to list file versions from. */
  readonly bucketId: BucketId
  /** Return files starting after this name (exclusive). Used for pagination. */
  readonly startFileName?: string
  /** Return file versions starting after this ID. Used with startFileName for pagination. */
  readonly startFileId?: FileId
  /** Maximum number of file versions to return (1 to 10000). */
  readonly maxFileCount?: number
  /** Only return files whose names start with this prefix. */
  readonly prefix?: string
  /** Delimiter for virtual folder grouping (typically `'/'`). */
  readonly delimiter?: string
}

/** Response from the `b2_list_file_versions` API call. */
export interface ListFileVersionsResponse {
  /** Array of file versions matching the request. */
  readonly files: readonly FileVersion[]
  /** Next file name to use for pagination, or null if all versions have been listed. */
  readonly nextFileName: string | null
  /** Next file ID to use for pagination, or null if all versions have been listed. */
  readonly nextFileId: FileId | null
}

/** Request parameters for the `b2_get_file_info` API call. */
export interface GetFileInfoRequest {
  /** ID of the file version to retrieve info for. */
  readonly fileId: FileId
}

/** Request parameters for the `b2_hide_file` API call. Hides a file so it no longer appears in `b2_list_file_names`. */
export interface HideFileRequest {
  /** Bucket containing the file to hide. */
  readonly bucketId: BucketId
  /** Name of the file to hide. */
  readonly fileName: string
}

/** Request parameters for the `b2_delete_file_version` API call. */
export interface DeleteFileVersionRequest {
  /** Name of the file version to delete. */
  readonly fileName: string
  /** ID of the file version to delete. */
  readonly fileId: FileId
  /** If true, bypass governance-mode retention. Requires the `bypassGovernance` capability. */
  readonly bypassGovernance?: boolean
}

/** Response from the `b2_delete_file_version` API call. */
export interface DeleteFileVersionResponse {
  /** ID of the deleted file version. */
  readonly fileId: FileId
  /** Name of the deleted file. */
  readonly fileName: string
}

/**
 * Controls how metadata is handled during a file copy.
 * - `'COPY'`: preserve the source file's metadata.
 * - `'REPLACE'`: use the metadata provided in the copy request.
 */
export type MetadataDirective = 'COPY' | 'REPLACE'

/** Request parameters for the `b2_copy_file` API call. Performs a server-side file copy. */
export interface CopyFileRequest {
  /** ID of the source file version to copy from. */
  readonly sourceFileId: FileId
  /** Destination bucket ID. Defaults to the source bucket if omitted. */
  readonly destinationBucketId?: BucketId
  /** Name for the destination file. */
  readonly fileName: string
  /** Byte range to copy (e.g., `'bytes=0-999'`). Omit to copy the entire file. */
  readonly range?: string
  /** Whether to copy or replace the source file's metadata. */
  readonly metadataDirective?: MetadataDirective
  /** MIME type for the destination file (only used when metadataDirective is `'REPLACE'`). */
  readonly contentType?: string
  /** User-defined metadata for the destination file (only used when metadataDirective is `'REPLACE'`). */
  readonly fileInfo?: Record<string, string>
  /** Object Lock retention for the destination file. */
  readonly fileRetention?: FileRetentionValue
  /** Legal hold for the destination file. */
  readonly legalHold?: LegalHoldValue
  /** SSE-C settings for reading the source file, if the source is encrypted with SSE-C. */
  readonly sourceServerSideEncryption?: EncryptionSetting
  /** Server-side encryption to apply to the destination file. */
  readonly destinationServerSideEncryption?: EncryptionSetting
}

/** Request parameters for the `b2_copy_part` API call. Copies a byte range into a large file part. */
export interface CopyPartRequest {
  /** ID of the source file version to copy from. */
  readonly sourceFileId: FileId
  /** ID of the large file being assembled. */
  readonly largeFileId: FileId
  /** Part number (1-based) for this part within the large file. */
  readonly partNumber: number
  /** Byte range to copy from the source (e.g., `'bytes=0-999'`). Omit to copy the entire source. */
  readonly range?: string
  /** SSE-C settings for reading the source file, if the source is encrypted with SSE-C. */
  readonly sourceServerSideEncryption?: EncryptionSetting
  /** Server-side encryption to apply to the destination part. */
  readonly destinationServerSideEncryption?: EncryptionSetting
}

/** Response from the `b2_copy_part` API call. */
export interface CopyPartResponse {
  /** ID of the large file this part belongs to. */
  readonly fileId: FileId
  /** Part number within the large file. */
  readonly partNumber: number
  /** Size of the copied part in bytes. */
  readonly contentLength: number
  /** SHA-1 checksum of the copied part content. */
  readonly contentSha1: string
}
