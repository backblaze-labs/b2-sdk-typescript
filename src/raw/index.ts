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
import { buildFileInfoHeaders, encodeFileName, parseFileInfoHeaders } from './encoding.js'

export interface RawClientOptions {
  readonly transport: HttpTransport
}

export class RawClient {
  private readonly transport: HttpTransport

  constructor(options: RawClientOptions) {
    this.transport = options.transport
  }

  // --- Auth ---

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

  async createBucket(
    apiUrl: string,
    authToken: string,
    request: CreateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_create_bucket', request)
  }

  async deleteBucket(
    apiUrl: string,
    authToken: string,
    request: DeleteBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_delete_bucket', request)
  }

  async listBuckets(
    apiUrl: string,
    authToken: string,
    request: ListBucketsRequest,
  ): Promise<ListBucketsResponse> {
    return this.postJson<ListBucketsResponse>(apiUrl, authToken, 'b2_list_buckets', request)
  }

  async updateBucket(
    apiUrl: string,
    authToken: string,
    request: UpdateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_update_bucket', request)
  }

  // --- Files ---

  async getUploadUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadUrlRequest,
  ): Promise<GetUploadUrlResponse> {
    return this.postJson<GetUploadUrlResponse>(apiUrl, authToken, 'b2_get_upload_url', request)
  }

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

  async listFileNames(
    apiUrl: string,
    authToken: string,
    request: ListFileNamesRequest,
  ): Promise<ListFileNamesResponse> {
    return this.postJson<ListFileNamesResponse>(apiUrl, authToken, 'b2_list_file_names', request)
  }

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

  async getFileInfo(
    apiUrl: string,
    authToken: string,
    request: GetFileInfoRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_get_file_info', request)
  }

  async hideFile(
    apiUrl: string,
    authToken: string,
    request: HideFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_hide_file', request)
  }

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

  async copyFile(
    apiUrl: string,
    authToken: string,
    request: CopyFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_copy_file', request)
  }

  async copyPart(
    apiUrl: string,
    authToken: string,
    request: CopyPartRequest,
  ): Promise<CopyPartResponse> {
    return this.postJson<CopyPartResponse>(apiUrl, authToken, 'b2_copy_part', request)
  }

  // --- Large Files ---

  async startLargeFile(
    apiUrl: string,
    authToken: string,
    request: StartLargeFileRequest,
  ): Promise<StartLargeFileResponse> {
    return this.postJson<StartLargeFileResponse>(apiUrl, authToken, 'b2_start_large_file', request)
  }

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

  async finishLargeFile(
    apiUrl: string,
    authToken: string,
    request: FinishLargeFileRequest,
  ): Promise<FileVersion> {
    return this.postJson<FileVersion>(apiUrl, authToken, 'b2_finish_large_file', request)
  }

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

  async listParts(
    apiUrl: string,
    authToken: string,
    request: ListPartsRequest,
  ): Promise<ListPartsResponse> {
    return this.postJson<ListPartsResponse>(apiUrl, authToken, 'b2_list_parts', request)
  }

  // --- Downloads ---

  async downloadFileById(
    downloadUrl: string,
    authToken: string,
    fileId: string,
    options?: { range?: string; signal?: AbortSignal },
  ): Promise<{ headers: Headers; body: ReadableStream<Uint8Array> | null; status: number }> {
    const headers: Record<string, string> = {
      Authorization: authToken,
    }
    if (options?.range) {
      headers.Range = options.range
    }

    const response = await this.transport.send({
      url: `${downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`,
      method: 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

  async downloadFileByName(
    downloadUrl: string,
    authToken: string,
    bucketName: string,
    fileName: string,
    options?: { range?: string; signal?: AbortSignal },
  ): Promise<{ headers: Headers; body: ReadableStream<Uint8Array> | null; status: number }> {
    const headers: Record<string, string> = {
      Authorization: authToken,
    }
    if (options?.range) {
      headers.Range = options.range
    }

    const response = await this.transport.send({
      url: `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeFileName(fileName)}`,
      method: 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

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

  async createKey(
    apiUrl: string,
    authToken: string,
    request: CreateKeyRequest,
  ): Promise<FullApplicationKey> {
    return this.postJson<FullApplicationKey>(apiUrl, authToken, 'b2_create_key', request)
  }

  async listKeys(
    apiUrl: string,
    authToken: string,
    request: ListKeysRequest,
  ): Promise<ListKeysResponse> {
    return this.postJson<ListKeysResponse>(apiUrl, authToken, 'b2_list_keys', request)
  }

  async deleteKey(
    apiUrl: string,
    authToken: string,
    request: DeleteKeyRequest,
  ): Promise<ApplicationKey> {
    return this.postJson<ApplicationKey>(apiUrl, authToken, 'b2_delete_key', request)
  }

  // --- Retention / Legal Hold ---

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
