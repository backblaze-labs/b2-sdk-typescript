/**
 * Low-level 1:1 bindings for every B2 native API endpoint.
 *
 * Each method on {@link RawClient} maps directly to a single `b2_*` HTTP call
 * with fully typed request and response objects. No retry logic, no URL pooling,
 * no automatic reauthorization. Use this when you need precise control over
 * individual API calls; for most use cases prefer the high-level `B2Client`.
 *
 * @packageDocumentation
 */

import type { HttpTransport } from '../http/transport.js'
import type {
  ApplicationKey,
  AuthorizeAccountResponse,
  BucketInfo,
  CancelLargeFileRequest,
  CancelLargeFileResponse,
  CopyFileRequest,
  CopyPartRequest,
  CopyPartResponse,
  CreateBucketRequest,
  CreateKeyRequest,
  DeleteBucketRequest,
  DeleteFileVersionRequest,
  DeleteFileVersionResponse,
  DeleteKeyRequest,
  DownloadAuthorizationRequest,
  DownloadAuthorizationResponse,
  FileVersion,
  FinishLargeFileRequest,
  FullApplicationKey,
  GetBucketNotificationRulesRequest,
  GetBucketNotificationRulesResponse,
  GetFileInfoRequest,
  GetUploadPartUrlRequest,
  GetUploadPartUrlResponse,
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  HideFileRequest,
  ListBucketsRequest,
  ListBucketsResponse,
  ListFileNamesRequest,
  ListFileNamesResponse,
  ListFileVersionsRequest,
  ListFileVersionsResponse,
  ListKeysRequest,
  ListKeysResponse,
  ListPartsRequest,
  ListPartsResponse,
  ListUnfinishedLargeFilesRequest,
  ListUnfinishedLargeFilesResponse,
  SetBucketNotificationRulesRequest,
  SetBucketNotificationRulesResponse,
  StartLargeFileRequest,
  StartLargeFileResponse,
  UpdateBucketRequest,
  UpdateFileLegalHoldRequest,
  UpdateFileLegalHoldResponse,
  UpdateFileRetentionRequest,
  UpdateFileRetentionResponse,
} from '../types/index.js'
import type { UploadFileHeaders, UploadPartHeaders, UploadPartResponse } from '../types/upload.js'
import { buildFileInfoHeaders, encodeFileName } from './encoding.js'

/** Configuration for constructing a {@link RawClient}. */
export interface RawClientOptions {
  /** The HTTP transport used to send requests (e.g., FetchTransport or RetryTransport). */
  readonly transport: HttpTransport
}

/**
 * Low-level client providing 1:1 bindings to all B2 native API endpoints.
 *
 * Each method maps directly to a single B2 API call. Most methods accept
 * `(apiUrl, authToken, request)` and return the JSON response. Upload and
 * download methods accept endpoint-specific parameters instead.
 */
export class RawClient {
  /** @internal */
  private readonly transport: HttpTransport

  /** Creates a new RawClient with the given transport. */
  constructor(options: RawClientOptions) {
    this.transport = options.transport
  }

  // --- Auth ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-authorize-account | b2_authorize_account}. */
  async authorizeAccount(
    applicationKeyId: string,
    applicationKey: string,
    realmUrl = 'https://api.backblazeb2.com',
  ): Promise<AuthorizeAccountResponse> {
    const response = await this.transport.send({
      url: `${realmUrl}/b2api/v3/b2_authorize_account`,
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${applicationKeyId}:${applicationKey}`)}`,
      },
    })
    return response.json<AuthorizeAccountResponse>()
  }

  // --- Buckets ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-create-bucket | b2_create_bucket}. */
  async createBucket(
    apiUrl: string,
    authToken: string,
    request: CreateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_create_bucket', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-delete-bucket | b2_delete_bucket}. */
  async deleteBucket(
    apiUrl: string,
    authToken: string,
    request: DeleteBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_delete_bucket', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-buckets | b2_list_buckets}. */
  async listBuckets(
    apiUrl: string,
    authToken: string,
    request: ListBucketsRequest,
  ): Promise<ListBucketsResponse> {
    return this.postJson<ListBucketsResponse>(apiUrl, authToken, 'b2_list_buckets', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-update-bucket | b2_update_bucket}. */
  async updateBucket(
    apiUrl: string,
    authToken: string,
    request: UpdateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_update_bucket', request)
  }

  // --- Files ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-get-upload-url | b2_get_upload_url}. */
  async getUploadUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadUrlRequest,
  ): Promise<GetUploadUrlResponse> {
    return this.postJson<GetUploadUrlResponse>(apiUrl, authToken, 'b2_get_upload_url', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-upload-file | b2_upload_file}.
   *
   * Unlike most methods, this posts directly to the `uploadUrl` obtained
   * from {@link getUploadUrl} rather than the API URL.
   */
  async uploadFile(
    uploadUrl: string,
    headers: UploadFileHeaders,
    body: BodyInit,
    signal?: AbortSignal,
  ): Promise<FileVersion> {
    const reqHeaders: Record<string, string> = {
      Authorization: headers.authorization,
      'X-Bz-File-Name': encodeFileName(headers.fileName),
      'Content-Type': headers.contentType,
      'Content-Length': String(headers.contentLength),
      'X-Bz-Content-Sha1': headers.contentSha1,
      ...buildFileInfoHeaders(headers.fileInfo),
    }

    if (headers.lastModifiedMillis !== undefined) {
      reqHeaders['X-Bz-Info-src_last_modified_millis'] = String(headers.lastModifiedMillis)
    }
    if (headers.contentDisposition) {
      reqHeaders['X-Bz-Info-b2-content-disposition'] = headers.contentDisposition
    }
    if (headers.contentLanguage) {
      reqHeaders['X-Bz-Info-b2-content-language'] = headers.contentLanguage
    }
    if (headers.expires) {
      reqHeaders['X-Bz-Info-b2-expires'] = headers.expires
    }
    if (headers.cacheControl) {
      reqHeaders['X-Bz-Info-b2-cache-control'] = headers.cacheControl
    }
    if (headers.contentEncoding) {
      reqHeaders['X-Bz-Info-b2-content-encoding'] = headers.contentEncoding
    }

    applyEncryptionHeaders(reqHeaders, headers.serverSideEncryption)
    applyRetentionHeaders(reqHeaders, headers.fileRetention)
    applyLegalHoldHeader(reqHeaders, headers.legalHold)

    const response = await this.transport.send({
      url: uploadUrl,
      method: 'POST',
      headers: reqHeaders,
      body,
      ...(signal !== undefined ? { signal } : {}),
    })
    return response.json<FileVersion>()
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-file-names | b2_list_file_names}. */
  async listFileNames(
    apiUrl: string,
    authToken: string,
    request: ListFileNamesRequest,
  ): Promise<ListFileNamesResponse> {
    return this.postJson<ListFileNamesResponse>(apiUrl, authToken, 'b2_list_file_names', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-file-versions | b2_list_file_versions}. */
  async listFileVersions(
    apiUrl: string,
    authToken: string,
    request: ListFileVersionsRequest,
  ): Promise<ListFileVersionsResponse> {
    return this.postJson<ListFileVersionsResponse>(
      apiUrl,
      authToken,
      'b2_list_file_versions',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-get-file-info | b2_get_file_info}. */
  async getFileInfo(
    apiUrl: string,
    authToken: string,
    request: GetFileInfoRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_get_file_info', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-hide-file | b2_hide_file}. */
  async hideFile(
    apiUrl: string,
    authToken: string,
    request: HideFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_hide_file', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-delete-file-version | b2_delete_file_version}. */
  async deleteFileVersion(
    apiUrl: string,
    authToken: string,
    request: DeleteFileVersionRequest,
  ): Promise<DeleteFileVersionResponse> {
    return this.postJson<DeleteFileVersionResponse>(
      apiUrl,
      authToken,
      'b2_delete_file_version',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-copy-file | b2_copy_file}. */
  async copyFile(
    apiUrl: string,
    authToken: string,
    request: CopyFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_copy_file', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-copy-part | b2_copy_part}. */
  async copyPart(
    apiUrl: string,
    authToken: string,
    request: CopyPartRequest,
  ): Promise<CopyPartResponse> {
    return this.postJson<CopyPartResponse>(apiUrl, authToken, 'b2_copy_part', request)
  }

  // --- Large Files ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-start-large-file | b2_start_large_file}. */
  async startLargeFile(
    apiUrl: string,
    authToken: string,
    request: StartLargeFileRequest,
  ): Promise<StartLargeFileResponse> {
    return this.postJson<StartLargeFileResponse>(apiUrl, authToken, 'b2_start_large_file', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-get-upload-part-url | b2_get_upload_part_url}. */
  async getUploadPartUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadPartUrlRequest,
  ): Promise<GetUploadPartUrlResponse> {
    return this.postJson<GetUploadPartUrlResponse>(
      apiUrl,
      authToken,
      'b2_get_upload_part_url',
      request,
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-upload-part | b2_upload_part}.
   *
   * Posts directly to the `uploadUrl` obtained from {@link getUploadPartUrl}
   * rather than the API URL.
   */
  async uploadPart(
    uploadUrl: string,
    headers: UploadPartHeaders,
    body: BodyInit,
    signal?: AbortSignal,
  ): Promise<UploadPartResponse> {
    const reqHeaders: Record<string, string> = {
      Authorization: headers.authorization,
      'X-Bz-Part-Number': String(headers.partNumber),
      'Content-Length': String(headers.contentLength),
      'X-Bz-Content-Sha1': headers.contentSha1,
    }

    applyEncryptionHeaders(reqHeaders, headers.serverSideEncryption)

    const response = await this.transport.send({
      url: uploadUrl,
      method: 'POST',
      headers: reqHeaders,
      body,
      ...(signal !== undefined ? { signal } : {}),
    })
    return response.json<UploadPartResponse>()
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-finish-large-file | b2_finish_large_file}. */
  async finishLargeFile(
    apiUrl: string,
    authToken: string,
    request: FinishLargeFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_finish_large_file', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-cancel-large-file | b2_cancel_large_file}. */
  async cancelLargeFile(
    apiUrl: string,
    authToken: string,
    request: CancelLargeFileRequest,
  ): Promise<CancelLargeFileResponse> {
    return this.postJson<CancelLargeFileResponse>(
      apiUrl,
      authToken,
      'b2_cancel_large_file',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-unfinished-large-files | b2_list_unfinished_large_files}. */
  async listUnfinishedLargeFiles(
    apiUrl: string,
    authToken: string,
    request: ListUnfinishedLargeFilesRequest,
  ): Promise<ListUnfinishedLargeFilesResponse> {
    return this.postJson<ListUnfinishedLargeFilesResponse>(
      apiUrl,
      authToken,
      'b2_list_unfinished_large_files',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-parts | b2_list_parts}. */
  async listParts(
    apiUrl: string,
    authToken: string,
    request: ListPartsRequest,
  ): Promise<ListPartsResponse> {
    return this.postJson<ListPartsResponse>(apiUrl, authToken, 'b2_list_parts', request)
  }

  // --- Downloads ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-download-file-by-id | b2_download_file_by_id}. */
  async downloadFileById(
    downloadUrl: string,
    authToken: string,
    fileId: string,
    options?: {
      /** HTTP Range header value for partial content requests. */ range?: string /** Signal to abort the download. */
      signal?: AbortSignal
    },
  ): Promise<{
    /** Response headers containing file metadata and B2 info headers. */
    headers: Headers
    /** Streaming response body, or `null` for HEAD-like responses. */
    body: ReadableStream<Uint8Array> | null
    /** HTTP status code (200 for full content, 206 for partial content). */
    status: number
  }> {
    const headers: Record<string, string> = {
      Authorization: authToken,
    }
    if (options?.range) {
      headers['Range'] = options.range
    }

    const response = await this.transport.send({
      url: `${downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`,
      method: 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-download-file-by-name | b2_download_file_by_name}. */
  async downloadFileByName(
    downloadUrl: string,
    authToken: string,
    bucketName: string,
    fileName: string,
    options?: {
      /** HTTP Range header value for partial content requests. */ range?: string /** Signal to abort the download. */
      signal?: AbortSignal
    },
  ): Promise<{
    /** Response headers containing file metadata and B2 info headers. */
    headers: Headers
    /** Streaming response body, or `null` for HEAD-like responses. */
    body: ReadableStream<Uint8Array> | null
    /** HTTP status code (200 for full content, 206 for partial content). */
    status: number
  }> {
    const headers: Record<string, string> = {
      Authorization: authToken,
    }
    if (options?.range) {
      headers['Range'] = options.range
    }

    const response = await this.transport.send({
      url: `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeFileName(fileName)}`,
      method: 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-get-download-authorization | b2_get_download_authorization}. */
  async getDownloadAuthorization(
    apiUrl: string,
    authToken: string,
    request: DownloadAuthorizationRequest,
  ): Promise<DownloadAuthorizationResponse> {
    return this.postJson<DownloadAuthorizationResponse>(
      apiUrl,
      authToken,
      'b2_get_download_authorization',
      request,
    )
  }

  // --- Keys ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-create-key | b2_create_key}. */
  async createKey(
    apiUrl: string,
    authToken: string,
    request: CreateKeyRequest,
  ): Promise<FullApplicationKey> {
    return this.postJson<FullApplicationKey>(apiUrl, authToken, 'b2_create_key', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-list-keys | b2_list_keys}. */
  async listKeys(
    apiUrl: string,
    authToken: string,
    request: ListKeysRequest,
  ): Promise<ListKeysResponse> {
    return this.postJson<ListKeysResponse>(apiUrl, authToken, 'b2_list_keys', request)
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-delete-key | b2_delete_key}. */
  async deleteKey(
    apiUrl: string,
    authToken: string,
    request: DeleteKeyRequest,
  ): Promise<ApplicationKey> {
    return this.postJson<ApplicationKey>(apiUrl, authToken, 'b2_delete_key', request)
  }

  // --- Retention / Legal Hold ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-update-file-retention | b2_update_file_retention}. */
  async updateFileRetention(
    apiUrl: string,
    authToken: string,
    request: UpdateFileRetentionRequest,
  ): Promise<UpdateFileRetentionResponse> {
    return this.postJson<UpdateFileRetentionResponse>(
      apiUrl,
      authToken,
      'b2_update_file_retention',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-update-file-legal-hold | b2_update_file_legal_hold}. */
  async updateFileLegalHold(
    apiUrl: string,
    authToken: string,
    request: UpdateFileLegalHoldRequest,
  ): Promise<UpdateFileLegalHoldResponse> {
    return this.postJson<UpdateFileLegalHoldResponse>(
      apiUrl,
      authToken,
      'b2_update_file_legal_hold',
      request,
    )
  }

  // --- Notifications ---

  /** Calls {@link https://www.backblaze.com/apidocs/b2-get-bucket-notification-rules | b2_get_bucket_notification_rules}. */
  async getBucketNotificationRules(
    apiUrl: string,
    authToken: string,
    request: GetBucketNotificationRulesRequest,
  ): Promise<GetBucketNotificationRulesResponse> {
    return this.postJson<GetBucketNotificationRulesResponse>(
      apiUrl,
      authToken,
      'b2_get_bucket_notification_rules',
      request,
    )
  }

  /** Calls {@link https://www.backblaze.com/apidocs/b2-set-bucket-notification-rules | b2_set_bucket_notification_rules}. */
  async setBucketNotificationRules(
    apiUrl: string,
    authToken: string,
    request: SetBucketNotificationRulesRequest,
  ): Promise<SetBucketNotificationRulesResponse> {
    return this.postJson<SetBucketNotificationRulesResponse>(
      apiUrl,
      authToken,
      'b2_set_bucket_notification_rules',
      request,
    )
  }

  // --- Internal ---

  private async postJson<T>(
    apiUrl: string,
    authToken: string,
    endpoint: string,
    body: unknown,
  ): Promise<T> {
    const response = await this.transport.send({
      url: `${apiUrl}/b2api/v3/${endpoint}`,
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    return response.json<T>()
  }
}

// --- Header helpers ---

import type { EncryptionSetting } from '../types/encryption.js'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.js'

function applyEncryptionHeaders(
  headers: Record<string, string>,
  encryption: EncryptionSetting | undefined,
): void {
  if (!encryption || encryption.mode === 'none') return
  if (encryption.mode === 'SSE-B2') {
    headers['X-Bz-Server-Side-Encryption'] = 'AES256'
  } else if (encryption.mode === 'SSE-C') {
    headers['X-Bz-Server-Side-Encryption-Customer-Algorithm'] = 'AES256'
    headers['X-Bz-Server-Side-Encryption-Customer-Key'] = encryption.customerKey
    headers['X-Bz-Server-Side-Encryption-Customer-Key-Md5'] = encryption.customerKeyMd5
  }
}

function applyRetentionHeaders(
  headers: Record<string, string>,
  retention: FileRetentionValue | undefined,
): void {
  if (!retention) return
  if (retention.mode) {
    headers['X-Bz-File-Retention-Mode'] = retention.mode
  }
  if (retention.retainUntilTimestamp) {
    headers['X-Bz-File-Retention-Retain-Until-Timestamp'] = String(retention.retainUntilTimestamp)
  }
}

function applyLegalHoldHeader(
  headers: Record<string, string>,
  legalHold: LegalHoldValue | undefined,
): void {
  if (!legalHold) return
  headers['X-Bz-File-Legal-Hold'] = legalHold
}

export {
  encodeFileName,
  decodeFileName,
  buildFileInfoHeaders,
  parseFileInfoHeaders,
} from './encoding.js'
