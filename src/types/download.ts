import type { BucketId, FileId } from './ids.js'

export interface DownloadByIdRequest {
  readonly fileId: FileId
  readonly range?: string
  readonly serverSideEncryption?: {
    readonly algorithm: 'AES256'
    readonly customerKey: string
    readonly customerKeyMd5: string
  }
}

export interface DownloadByNameRequest {
  readonly bucketName: string
  readonly fileName: string
  readonly range?: string
  readonly serverSideEncryption?: {
    readonly algorithm: 'AES256'
    readonly customerKey: string
    readonly customerKeyMd5: string
  }
  readonly b2ContentDisposition?: string
  readonly b2ContentLanguage?: string
  readonly b2ContentEncoding?: string
  readonly b2ContentType?: string
  readonly b2CacheControl?: string
  readonly b2Expires?: string
}

export interface DownloadAuthorizationRequest {
  readonly bucketId: BucketId
  readonly fileNamePrefix: string
  readonly validDurationInSeconds: number
  readonly b2ContentDisposition?: string
  readonly b2ContentLanguage?: string
  readonly b2ContentEncoding?: string
  readonly b2ContentType?: string
  readonly b2CacheControl?: string
  readonly b2Expires?: string
}

export interface DownloadAuthorizationResponse {
  readonly bucketId: BucketId
  readonly fileNamePrefix: string
  readonly authorizationToken: string
}

export interface DownloadHeaders {
  readonly contentType: string
  readonly contentLength: number
  readonly contentSha1: string | null
  readonly fileId: FileId
  readonly fileName: string
  readonly fileInfo: Record<string, string>
  readonly uploadTimestamp: number
}
