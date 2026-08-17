import type { SseB2Setting, SseCPublicSetting } from './encryption.ts'
import type { BucketId, FileId } from './ids.ts'
import type { ReadableFileRetention, ReadableLegalHold } from './upload.ts'

/** Request parameters for downloading a file by its ID via `b2_download_file_by_id`. */
export interface DownloadByIdRequest {
  /** ID of the file version to download. */
  readonly fileId: FileId
  /** Optional byte range to download (e.g., `'bytes=0-999'`). */
  readonly range?: string
  /** SSE-C decryption parameters, required if the file was uploaded with SSE-C. */
  readonly serverSideEncryption?: {
    /** Encryption algorithm. Always `'AES256'`. */
    readonly algorithm: 'AES256'
    /** Base64-encoded customer-provided decryption key. */
    readonly customerKey: string
    /** Base64-encoded MD5 digest of the decryption key. */
    readonly customerKeyMd5: string
  }
  /** Override the Content-Disposition header in the download response. */
  readonly b2ContentDisposition?: string
  /** Override the Content-Language header in the download response. */
  readonly b2ContentLanguage?: string
  /** Override the Content-Encoding header in the download response. */
  readonly b2ContentEncoding?: string
  /** Override the Content-Type header in the download response. */
  readonly b2ContentType?: string
  /** Override the Cache-Control header in the download response. */
  readonly b2CacheControl?: string
  /** Override the Expires header in the download response. */
  readonly b2Expires?: string
}

/** Request parameters for downloading a file by bucket name and file name via `b2_download_file_by_name`. */
export interface DownloadByNameRequest {
  /** Name of the bucket containing the file. */
  readonly bucketName: string
  /** Full path and name of the file within the bucket. */
  readonly fileName: string
  /** Optional byte range to download (e.g., `'bytes=0-999'`). */
  readonly range?: string
  /** SSE-C decryption parameters, required if the file was uploaded with SSE-C. */
  readonly serverSideEncryption?: {
    /** Encryption algorithm. Always `'AES256'`. */
    readonly algorithm: 'AES256'
    /** Base64-encoded customer-provided decryption key. */
    readonly customerKey: string
    /** Base64-encoded MD5 digest of the decryption key. */
    readonly customerKeyMd5: string
  }
  /** Override the Content-Disposition header in the download response. */
  readonly b2ContentDisposition?: string
  /** Override the Content-Language header in the download response. */
  readonly b2ContentLanguage?: string
  /** Override the Content-Encoding header in the download response. */
  readonly b2ContentEncoding?: string
  /** Override the Content-Type header in the download response. */
  readonly b2ContentType?: string
  /** Override the Cache-Control header in the download response. */
  readonly b2CacheControl?: string
  /** Override the Expires header in the download response. */
  readonly b2Expires?: string
}

/**
 * Request parameters for the `b2_get_download_authorization` API call.
 * Creates a time-limited token that authorizes downloads of files matching a prefix.
 */
export interface DownloadAuthorizationRequest {
  /** Bucket to authorize downloads from. */
  readonly bucketId: BucketId
  /** Only files with names starting with this prefix are authorized. */
  readonly fileNamePrefix: string
  /** Duration in seconds that the authorization token remains valid. */
  readonly validDurationInSeconds: number
  /** Override the Content-Disposition header in authorized download responses. */
  readonly b2ContentDisposition?: string
  /** Override the Content-Language header in authorized download responses. */
  readonly b2ContentLanguage?: string
  /** Override the Content-Encoding header in authorized download responses. */
  readonly b2ContentEncoding?: string
  /** Override the Content-Type header in authorized download responses. */
  readonly b2ContentType?: string
  /** Override the Cache-Control header in authorized download responses. */
  readonly b2CacheControl?: string
  /** Override the Expires header in authorized download responses. */
  readonly b2Expires?: string
}

/** Response from the `b2_get_download_authorization` API call. */
export interface DownloadAuthorizationResponse {
  /** Bucket the authorization applies to. */
  readonly bucketId: BucketId
  /** File name prefix the authorization is scoped to. */
  readonly fileNamePrefix: string
  /** Authorization token to include in download requests. */
  readonly authorizationToken: string
}

/** Server-side encryption metadata echoed in B2 download response headers. */
export type DownloadServerSideEncryption =
  | SseB2Setting
  | (SseCPublicSetting & {
      /** MD5 digest echoed by `X-Bz-Server-Side-Encryption-Customer-Key-Md5`. */
      readonly customerKeyMd5: string
    })

/** Parsed headers from a B2 file download response. */
export interface DownloadHeaders {
  /** MIME type of the downloaded file content. */
  readonly contentType: string
  /** Size of the downloaded content in bytes. */
  readonly contentLength: number
  /** Content-Disposition value computed from upload metadata or the download request. */
  readonly contentDisposition?: string
  /** Content-Language value computed from upload metadata or the download request. */
  readonly contentLanguage?: string
  /** Content-Encoding value computed from upload metadata or the download request. */
  readonly contentEncoding?: string
  /** Cache-Control value computed from upload metadata, bucket defaults, or the download request. */
  readonly cacheControl?: string
  /** Expires value computed from upload metadata or the download request. */
  readonly expires?: string
  /** Content-Range value returned for satisfiable range downloads. */
  readonly contentRange?: string
  /** SHA-1 checksum of the full file content, or null for large files. */
  readonly contentSha1: string | null
  /** ID of the downloaded file version. */
  readonly fileId: FileId
  /** Full path and name of the downloaded file. */
  readonly fileName: string
  /** User-defined key-value metadata stored with the file. */
  readonly fileInfo: Record<string, string>
  /** UTC timestamp (milliseconds) when the file was uploaded. */
  readonly uploadTimestamp: number
  /** Server-side encryption metadata echoed by B2, when the caller is authorized to read it. */
  readonly serverSideEncryption?: DownloadServerSideEncryption
  /** Object Lock retention metadata, including whether the caller may read it. */
  readonly fileRetention?: ReadableFileRetention
  /** Object Lock legal hold metadata, including whether the caller may read it. */
  readonly legalHold?: ReadableLegalHold
  /** Header names B2 omitted because the caller lacks capability to read them. */
  readonly clientUnauthorizedToRead?: readonly string[]
}
