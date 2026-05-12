import type { EncryptionSetting } from './encryption.js'
import type { AccountId, BucketId, FileId } from './ids.js'
import type { FileRetentionValue, LegalHoldValue } from './lock.js'

export type FileAction = 'start' | 'upload' | 'hide' | 'folder' | 'copy'

export interface FileVersion {
  readonly accountId: AccountId
  readonly action: FileAction
  readonly bucketId: BucketId
  readonly contentLength: number
  readonly contentMd5: string | null
  readonly contentSha1: string | null
  readonly contentType: string
  readonly fileId: FileId
  readonly fileInfo: Record<string, string>
  readonly fileName: string
  readonly fileRetention: {
    readonly isClientAuthorizedToRead: boolean
    readonly value: FileRetentionValue | null
  }
  readonly legalHold: {
    readonly isClientAuthorizedToRead: boolean
    readonly value: LegalHoldValue | null
  }
  readonly replicationStatus: 'pending' | 'completed' | 'failed' | 'replica' | null
  readonly serverSideEncryption: EncryptionSetting
  readonly uploadTimestamp: number
}

export interface ListFileNamesRequest {
  readonly bucketId: BucketId
  readonly startFileName?: string
  readonly maxFileCount?: number
  readonly prefix?: string
  readonly delimiter?: string
}

export interface ListFileNamesResponse {
  readonly files: readonly FileVersion[]
  readonly nextFileName: string | null
}

export interface ListFileVersionsRequest {
  readonly bucketId: BucketId
  readonly startFileName?: string
  readonly startFileId?: FileId
  readonly maxFileCount?: number
  readonly prefix?: string
  readonly delimiter?: string
}

export interface ListFileVersionsResponse {
  readonly files: readonly FileVersion[]
  readonly nextFileName: string | null
  readonly nextFileId: FileId | null
}

export interface GetFileInfoRequest {
  readonly fileId: FileId
}

export interface HideFileRequest {
  readonly bucketId: BucketId
  readonly fileName: string
}

export interface DeleteFileVersionRequest {
  readonly fileName: string
  readonly fileId: FileId
  readonly bypassGovernance?: boolean
}

export interface DeleteFileVersionResponse {
  readonly fileId: FileId
  readonly fileName: string
}

export type MetadataDirective = 'COPY' | 'REPLACE'

export interface CopyFileRequest {
  readonly sourceFileId: FileId
  readonly destinationBucketId?: BucketId
  readonly fileName: string
  readonly range?: string
  readonly metadataDirective?: MetadataDirective
  readonly contentType?: string
  readonly fileInfo?: Record<string, string>
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
  readonly sourceServerSideEncryption?: EncryptionSetting
  readonly destinationServerSideEncryption?: EncryptionSetting
}

export interface CopyPartRequest {
  readonly sourceFileId: FileId
  readonly largeFileId: FileId
  readonly partNumber: number
  readonly range?: string
  readonly sourceServerSideEncryption?: EncryptionSetting
  readonly destinationServerSideEncryption?: EncryptionSetting
}

export interface CopyPartResponse {
  readonly fileId: FileId
  readonly partNumber: number
  readonly contentLength: number
  readonly contentSha1: string
}
