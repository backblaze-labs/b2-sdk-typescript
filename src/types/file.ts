import type { EncryptionSetting, PublicEncryptionSetting } from './encryption.ts'
import type { AccountId, BucketId, FileId } from './ids.ts'
import type { FileRetentionValue, LegalHoldValue } from './lock.ts'

/**
 * Named constants for the action that created a file version.
 *
 * @example
 * ```ts
 * if (file.action === FileAction.Hide) { ... }
 * ```
 */
export const FileAction = {
  /** Large file upload started but not yet finished. */
  Start: 'start',
  /** Normal upload (small or finished large file). */
  Upload: 'upload',
  /** Hide marker (soft delete). */
  Hide: 'hide',
  /** Virtual folder marker. */
  Folder: 'folder',
  /** Created via server-side copy. */
  Copy: 'copy',
} as const

/** MIME type B2 returns for hide-marker rows in `b2_list_file_versions`. */
export const HIDE_MARKER_CONTENT_TYPE = 'application/x-bz-hide-marker' as const

/**
 * The action that created a file version. Derived from {@link FileAction}.
 *
 * - `'start'`: large file upload started but not yet finished.
 * - `'upload'`: file was uploaded normally.
 * - `'hide'`: file was hidden (soft-deleted).
 * - `'folder'`: virtual folder marker.
 * - `'copy'`: file was created via server-side copy.
 */
export type FileAction = (typeof FileAction)[keyof typeof FileAction]

/** File actions that represent concrete file versions with a B2 file ID. */
export type ConcreteFileAction = Exclude<FileAction, typeof FileAction.Folder>

/** File actions that represent listed concrete versions with file metadata. */
export type ListedFileAction = Exclude<ConcreteFileAction, typeof FileAction.Hide>

/**
 * Replication status for a file version or unfinished large file.
 *
 * B2 returns these uppercase wire values as-is and omits the containing
 * `replicationStatus` field when the file is not covered by a replication rule.
 */
export type ReplicationStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REPLICA'

/**
 * Complete metadata for a concrete file version in B2. Returned by
 * `b2_get_file_info`, `b2_upload_file`, `b2_copy_file`, `b2_hide_file`, and
 * other file-related endpoints. List endpoints return
 * {@link ListedFileVersion} for file-name listings and
 * {@link ListedConcreteFileVersion} for file-version listings unless a
 * delimiter is requested, in which case file-name listings return
 * {@link FileNameListEntry} and file-version listings return
 * {@link FileVersionListEntry}.
 */
export interface FileVersion {
  /** Account that owns this file. */
  readonly accountId: AccountId
  /** Action that created this file version. */
  readonly action: ConcreteFileAction
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
  /** Replication status when this file is covered by a replication rule. */
  readonly replicationStatus?: ReplicationStatus
  /** Server-side encryption settings applied to this file version. */
  readonly serverSideEncryption: PublicEncryptionSetting
  /** UTC timestamp (milliseconds) when this version was uploaded. */
  readonly uploadTimestamp: number
}

/** Concrete non-hide file version as returned from list endpoints. */
export interface ListedFileVersion extends Omit<FileVersion, 'action'> {
  /** Non-hide action with full file metadata. */
  readonly action: ListedFileAction
}

/** Hide marker as returned from list endpoints when B2 omits metadata fields. */
export interface ListedHideFileVersion
  extends Omit<
    FileVersion,
    'action' | 'contentType' | 'fileRetention' | 'legalHold' | 'serverSideEncryption'
  > {
  /** Hide marker (soft delete). */
  readonly action: typeof FileAction.Hide
  /** B2 list APIs return the documented hide-marker MIME type. */
  readonly contentType: typeof HIDE_MARKER_CONTENT_TYPE
}

/** Virtual folder row returned by list endpoints when a delimiter groups file names. */
export interface FolderFileVersion {
  /** Account that owns this bucket. */
  readonly accountId: AccountId
  /** Virtual folder marker. */
  readonly action: typeof FileAction.Folder
  /** Bucket containing the grouped files. */
  readonly bucketId: BucketId
  /** Always 0 for virtual folder rows. */
  readonly contentLength: 0
  /** Always null for virtual folder rows. */
  readonly contentMd5: null
  /** Always null for virtual folder rows. */
  readonly contentSha1: null
  /** Always null for virtual folder rows. */
  readonly contentType: null
  /** Always null for virtual folder rows. */
  readonly fileId: null
  /** Virtual folder rows do not carry file metadata. */
  readonly fileInfo: Record<string, string>
  /** Folder name, including the delimiter suffix. */
  readonly fileName: string
  /** Always 0 for virtual folder rows. */
  readonly uploadTimestamp: 0
}

/** Concrete file-version entry returned by list endpoints. */
export type ListedConcreteFileVersion = ListedFileVersion | ListedHideFileVersion

/** Entry returned by `b2_list_file_names` when a delimiter groups file names. */
export type FileNameListEntry = ListedFileVersion | FolderFileVersion

/** Entry returned by `b2_list_file_names` and `b2_list_file_versions`. */
export type FileVersionListEntry = ListedConcreteFileVersion | FolderFileVersion

/**
 * Request parameters shared by `b2_list_file_names` calls.
 */
export interface ListFileNamesBaseRequest {
  /** Bucket to list files from. */
  readonly bucketId: BucketId
  /** Return files starting after this name (exclusive). Used for pagination. */
  readonly startFileName?: string
  /** Maximum number of files to return (1 to 10000). */
  readonly maxFileCount?: number
  /** Only return files whose names start with this prefix. */
  readonly prefix?: string
}

/**
 * Request parameters for the non-delimiter `b2_list_file_names` API call.
 * Lists visible latest file versions in a bucket without hide markers or
 * virtual folder rows. Use {@link ListFileNamesWithDelimiterRequest} when
 * sending a `delimiter`.
 */
export interface ListFileNamesRequest extends ListFileNamesBaseRequest {
  /** Omit delimiter to receive only visible concrete file-version entries. */
  readonly delimiter?: undefined
}

/** Request parameters for delimiter-grouped `b2_list_file_names` calls. */
export interface ListFileNamesWithDelimiterRequest extends ListFileNamesBaseRequest {
  /** Delimiter for virtual folder grouping (typically `'/'`). */
  readonly delimiter: string
}

/** Request parameters for callers that dynamically include a delimiter. */
export interface ListFileNamesMaybeDelimiterRequest extends ListFileNamesBaseRequest {
  /** Optional delimiter for virtual folder grouping. */
  readonly delimiter?: string | undefined
}

/** Response from non-delimiter `b2_list_file_names` calls. */
export interface ListFileNamesResponse {
  /** Array of visible concrete file-version entries matching the request. */
  readonly files: readonly ListedFileVersion[]
  /** Next file name to use for pagination, or null if all files have been listed. */
  readonly nextFileName: string | null
}

/** Response from delimiter-grouped `b2_list_file_names` calls. */
export interface ListFileNamesWithDelimiterResponse {
  /** Array of visible concrete file-version or virtual-folder entries. */
  readonly files: readonly FileNameListEntry[]
  /** Next file name to use for pagination, or null if all files have been listed. */
  readonly nextFileName: string | null
}

/**
 * Request parameters shared by `b2_list_file_versions` calls.
 */
export interface ListFileVersionsBaseRequest {
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
}

/**
 * Request parameters for the non-delimiter `b2_list_file_versions` API call.
 * Lists all versions of files in a bucket without virtual folder rows. Use
 * {@link ListFileVersionsWithDelimiterRequest} when sending a `delimiter`.
 */
export interface ListFileVersionsRequest extends ListFileVersionsBaseRequest {
  /** Omit delimiter to receive only concrete file-version entries. */
  readonly delimiter?: undefined
}

/** Request parameters for delimiter-grouped `b2_list_file_versions` calls. */
export interface ListFileVersionsWithDelimiterRequest extends ListFileVersionsBaseRequest {
  /** Delimiter for virtual folder grouping (typically `'/'`). */
  readonly delimiter: string
}

/** Request parameters for callers that dynamically include a delimiter. */
export interface ListFileVersionsMaybeDelimiterRequest extends ListFileVersionsBaseRequest {
  /** Optional delimiter for virtual folder grouping. */
  readonly delimiter?: string | undefined
}

/** Response from non-delimiter `b2_list_file_versions` calls. */
export interface ListFileVersionsResponse {
  /** Array of concrete file-version entries matching the request. */
  readonly files: readonly ListedConcreteFileVersion[]
  /** Next file name to use for pagination, or null if all versions have been listed. */
  readonly nextFileName: string | null
  /** Next file ID to use for pagination, or null if all versions have been listed. */
  readonly nextFileId: FileId | null
}

/** Response from delimiter-grouped `b2_list_file_versions` calls. */
export interface ListFileVersionsWithDelimiterResponse {
  /** Array of concrete file-version or virtual-folder entries matching the request. */
  readonly files: readonly FileVersionListEntry[]
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
 * Named constants for how metadata is handled during a file copy.
 *
 * @example
 * ```ts
 * await bucket.copyFile({ ..., metadataDirective: MetadataDirective.Replace })
 * ```
 */
export const MetadataDirective = {
  /** Preserve the source file's contentType and fileInfo. */
  Copy: 'COPY',
  /** Use the values provided in the copy request. */
  Replace: 'REPLACE',
} as const

/** Controls how metadata is handled during a file copy. Derived from {@link MetadataDirective}. */
export type MetadataDirective = (typeof MetadataDirective)[keyof typeof MetadataDirective]

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
  /** MD5 checksum of the copied part content, or null if not available. */
  readonly contentMd5: string | null
  /** Server-side encryption applied to this copied part. */
  readonly serverSideEncryption: PublicEncryptionSetting
  /** UTC timestamp (milliseconds) when this part was copied. */
  readonly uploadTimestamp: number
}
