import type { EncryptionSetting } from './encryption.js'
import type { BucketId, LargeFileId } from './ids.js'
import type { FileRetentionValue, LegalHoldValue } from './lock.js'

export interface GetUploadUrlRequest {
  readonly bucketId: BucketId
}

export interface GetUploadUrlResponse {
  readonly bucketId: BucketId
  readonly uploadUrl: string
  readonly authorizationToken: string
}

export interface UploadFileHeaders {
  readonly authorization: string
  readonly fileName: string
  readonly contentType: string
  readonly contentLength: number
  readonly contentSha1: string | 'hex_digits_at_end' | 'do_not_verify'
  readonly fileInfo?: Record<string, string>
  readonly serverSideEncryption?: EncryptionSetting
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
  readonly lastModifiedMillis?: number
  readonly contentDisposition?: string
  readonly contentLanguage?: string
  readonly expires?: string
  readonly cacheControl?: string
  readonly contentEncoding?: string
}

export interface StartLargeFileRequest {
  readonly bucketId: BucketId
  readonly fileName: string
  readonly contentType: string
  readonly fileInfo?: Record<string, string>
  readonly serverSideEncryption?: EncryptionSetting
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
}

export interface StartLargeFileResponse {
  readonly fileId: LargeFileId
  readonly fileName: string
  readonly accountId: string
  readonly bucketId: BucketId
  readonly contentType: string
  readonly fileInfo: Record<string, string>
}

export interface GetUploadPartUrlRequest {
  readonly fileId: LargeFileId
}

export interface GetUploadPartUrlResponse {
  readonly fileId: LargeFileId
  readonly uploadUrl: string
  readonly authorizationToken: string
}

export interface UploadPartHeaders {
  readonly authorization: string
  readonly partNumber: number
  readonly contentLength: number
  readonly contentSha1: string | 'hex_digits_at_end' | 'do_not_verify'
  readonly serverSideEncryption?: EncryptionSetting
}

export interface UploadPartResponse {
  readonly fileId: LargeFileId
  readonly partNumber: number
  readonly contentLength: number
  readonly contentSha1: string
  readonly serverSideEncryption: EncryptionSetting
  readonly uploadTimestamp: number
}

export interface FinishLargeFileRequest {
  readonly fileId: LargeFileId
  readonly partSha1Array: readonly string[]
}

export interface CancelLargeFileRequest {
  readonly fileId: LargeFileId
}

export interface CancelLargeFileResponse {
  readonly fileId: LargeFileId
  readonly accountId: string
  readonly bucketId: BucketId
  readonly fileName: string
}

export interface ListUnfinishedLargeFilesRequest {
  readonly bucketId: BucketId
  readonly namePrefix?: string
  readonly startFileId?: LargeFileId
  readonly maxFileCount?: number
}

export interface UnfinishedLargeFile {
  readonly fileId: LargeFileId
  readonly fileName: string
  readonly accountId: string
  readonly bucketId: BucketId
  readonly contentType: string
  readonly fileInfo: Record<string, string>
}

export interface ListUnfinishedLargeFilesResponse {
  readonly files: readonly UnfinishedLargeFile[]
  readonly nextFileId: LargeFileId | null
}

export interface ListPartsRequest {
  readonly fileId: LargeFileId
  readonly startPartNumber?: number
  readonly maxPartCount?: number
}

export interface PartInfo {
  readonly fileId: LargeFileId
  readonly partNumber: number
  readonly contentLength: number
  readonly contentSha1: string
  readonly uploadTimestamp: number
}

export interface ListPartsResponse {
  readonly parts: readonly PartInfo[]
  readonly nextPartNumber: number | null
}
