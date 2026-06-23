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

import { assertSecureRealmUrl } from '../auth/realms.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
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
} from '../types/index.ts'
import type { UploadFileHeaders, UploadPartHeaders, UploadPartResponse } from '../types/upload.ts'
import { normalizeFileVersionListSha1, normalizeFileVersionSha1 } from '../util/normalize.ts'
import { buildFileInfoHeaders, encodeFileName } from './encoding.ts'

/** Configuration for constructing a {@link RawClient}. */
export interface RawClientOptions {
  /** The HTTP transport used to send requests (e.g., FetchTransport or RetryTransport). */
  readonly transport: HttpTransport
}

/** Optional request controls for {@link RawClient.listFileNames}. */
export type ListFileNamesOptions = RawRequestOptions

/** Optional request controls for {@link RawClient.listFileVersions}. */
export type ListFileVersionsOptions = RawRequestOptions

/** Optional controls for raw JSON API requests. */
export interface RawRequestOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
  /** Per-request retry override. */
  readonly retry?: Partial<RetryOptions>
}

function normalizeRawRequestOptions(
  optionsOrSignal?: RawRequestOptions | AbortSignal,
  retry?: Partial<RetryOptions>,
): RawRequestOptions | undefined {
  if (optionsOrSignal === undefined) {
    return retry === undefined ? undefined : { retry }
  }
  if (isAbortSignal(optionsOrSignal)) {
    return {
      signal: optionsOrSignal,
      ...(retry !== undefined ? { retry } : {}),
    }
  }
  return retry === undefined ? optionsOrSignal : { ...optionsOrSignal, retry }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  // Back-compat only: legacy upload-URL overloads accepted an AbortSignal as
  // the fourth positional argument. Prefer the RawRequestOptions bag.
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    typeof (value as AbortSignal).addEventListener === 'function'
  )
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

  /**
   * Creates a new RawClient with the given transport.
   * @param options - The constructor configuration.
   */
  constructor(options: RawClientOptions) {
    this.transport = options.transport
  }

  // --- Auth ---

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-authorize-account | b2_authorize_account}.
   * @param applicationKeyId - The application key ID for authentication.
   * @param applicationKey - The application key secret.
   * @param realmUrl - The B2 realm URL to authenticate against.
   *
   * @returns The authorization response with API URLs and credentials.
   */
  async authorizeAccount(
    applicationKeyId: string,
    applicationKey: string,
    realmUrl = 'https://api.backblazeb2.com',
  ): Promise<AuthorizeAccountResponse> {
    assertSecureRealmUrl(realmUrl)
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-create-bucket | b2_create_bucket}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The created bucket metadata.
   */
  async createBucket(
    apiUrl: string,
    authToken: string,
    request: CreateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_create_bucket', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-delete-bucket | b2_delete_bucket}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The deleted bucket metadata.
   */
  async deleteBucket(
    apiUrl: string,
    authToken: string,
    request: DeleteBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_delete_bucket', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-buckets | b2_list_buckets}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The list of matching buckets.
   */
  async listBuckets(
    apiUrl: string,
    authToken: string,
    request: ListBucketsRequest,
  ): Promise<ListBucketsResponse> {
    return this.postJson<ListBucketsResponse>(apiUrl, authToken, 'b2_list_buckets', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-update-bucket | b2_update_bucket}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The updated bucket metadata.
   */
  async updateBucket(
    apiUrl: string,
    authToken: string,
    request: UpdateBucketRequest,
  ): Promise<BucketInfo> {
    return this.postJson<BucketInfo>(apiUrl, authToken, 'b2_update_bucket', request)
  }

  // --- Files ---

  /**
   * Calls `b2_get_upload_url` with legacy positional request controls.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param signal - Optional abort signal for cancellation.
   * @param retry - Optional per-request retry override.
   *
   * @returns The upload URL and authorization token.
   *
   * @deprecated Use the options-bag overload: `getUploadUrl(apiUrl, authToken, request, { signal, retry })`.
   */
  async getUploadUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadUrlRequest,
    signal?: AbortSignal,
    retry?: Partial<RetryOptions>,
  ): Promise<GetUploadUrlResponse>
  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-get-upload-url | b2_get_upload_url}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry overrides.
   *
   * @returns The upload URL and authorization token.
   */
  async getUploadUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadUrlRequest,
    options?: RawRequestOptions,
  ): Promise<GetUploadUrlResponse>
  /**
   * Implementation for both upload URL request-control signatures.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param optionsOrSignal - Options bag or legacy abort signal.
   * @param retry - Optional legacy per-request retry override.
   *
   * @returns The upload URL and authorization token.
   */
  async getUploadUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadUrlRequest,
    optionsOrSignal?: RawRequestOptions | AbortSignal,
    retry?: Partial<RetryOptions>,
  ): Promise<GetUploadUrlResponse> {
    return this.postJson<GetUploadUrlResponse>(
      apiUrl,
      authToken,
      'b2_get_upload_url',
      request,
      normalizeRawRequestOptions(optionsOrSignal, retry),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-upload-file | b2_upload_file}.
   *
   * Unlike most methods, this posts directly to the `uploadUrl` obtained
   * from {@link getUploadUrl} rather than the API URL.
   * @param uploadUrl - The upload endpoint URL.
   * @param headers - The request headers including authorization and content metadata.
   * @param body - The file data to upload.
   * @param signal - An optional abort signal for cancellation.
   *
   * @returns The uploaded file version metadata.
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
    return normalizeFileVersionSha1(await response.json<FileVersion>())
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-file-names | b2_list_file_names}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns The list of file names and optional continuation token.
   */
  async listFileNames(
    apiUrl: string,
    authToken: string,
    request: ListFileNamesRequest,
    options?: ListFileNamesOptions,
  ): Promise<ListFileNamesResponse> {
    return normalizeFileVersionListSha1(
      await this.postJson<ListFileNamesResponse>(
        apiUrl,
        authToken,
        'b2_list_file_names',
        request,
        options,
      ),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-file-versions | b2_list_file_versions}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns The list of file versions and optional continuation token.
   */
  async listFileVersions(
    apiUrl: string,
    authToken: string,
    request: ListFileVersionsRequest,
    options?: ListFileVersionsOptions,
  ): Promise<ListFileVersionsResponse> {
    return normalizeFileVersionListSha1(
      await this.postJson<ListFileVersionsResponse>(
        apiUrl,
        authToken,
        'b2_list_file_versions',
        request,
        options,
      ),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-get-file-info | b2_get_file_info}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The file version metadata.
   */
  async getFileInfo(
    apiUrl: string,
    authToken: string,
    request: GetFileInfoRequest,
  ): Promise<FileVersion> {
    return normalizeFileVersionSha1(
      await this.postJson<FileVersion>(apiUrl, authToken, 'b2_get_file_info', request),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-hide-file | b2_hide_file}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns The hidden file version metadata.
   */
  async hideFile(
    apiUrl: string,
    authToken: string,
    request: HideFileRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FileVersion> {
    return normalizeFileVersionSha1(
      await this.postJson<FileVersion>(apiUrl, authToken, 'b2_hide_file', request, options),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-delete-file-version | b2_delete_file_version}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns The deleted file version identifier.
   */
  async deleteFileVersion(
    apiUrl: string,
    authToken: string,
    request: DeleteFileVersionRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<DeleteFileVersionResponse> {
    return this.postJson<DeleteFileVersionResponse>(
      apiUrl,
      authToken,
      'b2_delete_file_version',
      request,
      options,
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-copy-file | b2_copy_file}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as an abort signal.
   *
   * @returns The copied file version metadata.
   */
  async copyFile(
    apiUrl: string,
    authToken: string,
    request: CopyFileRequest,
    options?: RawRequestOptions,
  ): Promise<FileVersion> {
    return normalizeFileVersionSha1(
      await this.postJson<FileVersion>(apiUrl, authToken, 'b2_copy_file', request, options),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-copy-part | b2_copy_part}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The copied part metadata.
   */
  async copyPart(
    apiUrl: string,
    authToken: string,
    request: CopyPartRequest,
  ): Promise<CopyPartResponse> {
    return this.postJson<CopyPartResponse>(apiUrl, authToken, 'b2_copy_part', request)
  }

  // --- Large Files ---

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-start-large-file | b2_start_large_file}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry overrides.
   *
   * @returns The started large file metadata with file ID.
   */
  async startLargeFile(
    apiUrl: string,
    authToken: string,
    request: StartLargeFileRequest,
    options?: RawRequestOptions,
  ): Promise<StartLargeFileResponse> {
    return this.postJson<StartLargeFileResponse>(
      apiUrl,
      authToken,
      'b2_start_large_file',
      request,
      options,
    )
  }

  /**
   * Calls `b2_get_upload_part_url` with legacy positional request controls.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param signal - Optional abort signal for cancellation.
   * @param retry - Optional per-request retry override.
   *
   * @returns The upload part URL and authorization token.
   *
   * @deprecated Use the options-bag overload: `getUploadPartUrl(apiUrl, authToken, request, { signal, retry })`.
   */
  async getUploadPartUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadPartUrlRequest,
    signal?: AbortSignal,
    retry?: Partial<RetryOptions>,
  ): Promise<GetUploadPartUrlResponse>
  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-get-upload-part-url | b2_get_upload_part_url}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry overrides.
   *
   * @returns The upload part URL and authorization token.
   */
  async getUploadPartUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadPartUrlRequest,
    options?: RawRequestOptions,
  ): Promise<GetUploadPartUrlResponse>
  /**
   * Implementation for both upload part URL request-control signatures.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param optionsOrSignal - Options bag or legacy abort signal.
   * @param retry - Optional legacy per-request retry override.
   *
   * @returns The upload part URL and authorization token.
   */
  async getUploadPartUrl(
    apiUrl: string,
    authToken: string,
    request: GetUploadPartUrlRequest,
    optionsOrSignal?: RawRequestOptions | AbortSignal,
    retry?: Partial<RetryOptions>,
  ): Promise<GetUploadPartUrlResponse> {
    return this.postJson<GetUploadPartUrlResponse>(
      apiUrl,
      authToken,
      'b2_get_upload_part_url',
      request,
      normalizeRawRequestOptions(optionsOrSignal, retry),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-upload-part | b2_upload_part}.
   *
   * Posts directly to the `uploadUrl` obtained from {@link getUploadPartUrl}
   * rather than the API URL.
   * @param uploadUrl - The upload endpoint URL.
   * @param headers - The request headers including authorization and content metadata.
   * @param body - The file data to upload.
   * @param signal - An optional abort signal for cancellation.
   *
   * @returns The uploaded part metadata.
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-finish-large-file | b2_finish_large_file}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry overrides.
   *
   * @returns The completed file version metadata.
   */
  async finishLargeFile(
    apiUrl: string,
    authToken: string,
    request: FinishLargeFileRequest,
    options?: RawRequestOptions,
  ): Promise<FileVersion> {
    return normalizeFileVersionSha1(
      await this.postJson<FileVersion>(apiUrl, authToken, 'b2_finish_large_file', request, options),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-cancel-large-file | b2_cancel_large_file}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry overrides.
   *
   * @returns The cancelled large file metadata.
   */
  async cancelLargeFile(
    apiUrl: string,
    authToken: string,
    request: CancelLargeFileRequest,
    options?: RawRequestOptions,
  ): Promise<CancelLargeFileResponse> {
    return this.postJson<CancelLargeFileResponse>(
      apiUrl,
      authToken,
      'b2_cancel_large_file',
      request,
      options,
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-unfinished-large-files | b2_list_unfinished_large_files}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry.
   *
   * @returns The list of unfinished large files and optional continuation token.
   */
  async listUnfinishedLargeFiles(
    apiUrl: string,
    authToken: string,
    request: ListUnfinishedLargeFilesRequest,
    options?: RawRequestOptions,
  ): Promise<ListUnfinishedLargeFilesResponse> {
    return this.postJson<ListUnfinishedLargeFilesResponse>(
      apiUrl,
      authToken,
      'b2_list_unfinished_large_files',
      request,
      options,
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-parts | b2_list_parts}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   * @param options - Optional request controls such as cancellation and retry.
   *
   * @returns The list of uploaded parts and optional continuation token.
   */
  async listParts(
    apiUrl: string,
    authToken: string,
    request: ListPartsRequest,
    options?: RawRequestOptions,
  ): Promise<ListPartsResponse> {
    return this.postJson<ListPartsResponse>(apiUrl, authToken, 'b2_list_parts', request, options)
  }

  // --- Downloads ---

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-download-file-by-id | b2_download_file_by_id}.
   * @param downloadUrl - The B2 download base URL.
   * @param authToken - The authorization token.
   * @param fileId - The unique identifier of the file to download.
   * @param options - Optional download parameters for range requests and cancellation.
   *
   * @returns The response headers, streaming body, and HTTP status code.
   */
  async downloadFileById(
    downloadUrl: string,
    authToken: string,
    fileId: string,
    options?: DownloadFileOptions,
  ): Promise<{
    /** Response headers containing file metadata and B2 info headers. */
    headers: Headers
    /** Streaming response body, or `null` for HEAD-like responses. */
    body: ReadableStream<Uint8Array> | null
    /** HTTP status code (200 for full content, 206 for partial content). */
    status: number
  }> {
    const headers = buildDownloadRequestHeaders(authToken, options)
    const url = appendDownloadOverrides(
      `${downloadUrl}/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`,
      options,
    )

    const response = await this.transport.send({
      url,
      method: options?.method ?? 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-download-file-by-name | b2_download_file_by_name}.
   * @param downloadUrl - The B2 download base URL.
   * @param authToken - The authorization token.
   * @param bucketName - The name of the bucket containing the file.
   * @param fileName - The name of the file to download.
   * @param options - Optional download parameters for range requests and cancellation.
   *
   * @returns The response headers, streaming body, and HTTP status code.
   */
  async downloadFileByName(
    downloadUrl: string,
    authToken: string,
    bucketName: string,
    fileName: string,
    options?: DownloadFileOptions,
  ): Promise<{
    /** Response headers containing file metadata and B2 info headers. */
    headers: Headers
    /** Streaming response body, or `null` for HEAD-like responses. */
    body: ReadableStream<Uint8Array> | null
    /** HTTP status code (200 for full content, 206 for partial content). */
    status: number
  }> {
    const headers = buildDownloadRequestHeaders(authToken, options)
    const url = appendDownloadOverrides(
      `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeFileName(fileName)}`,
      options,
    )

    const response = await this.transport.send({
      url,
      method: options?.method ?? 'GET',
      headers,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    })

    return { headers: response.headers, body: response.body, status: response.status }
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-get-download-authorization | b2_get_download_authorization}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The current session authorization token.
   * @param request - The API request parameters.
   *
   * @returns The download authorization token for the specified file prefix.
   */
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-create-key | b2_create_key}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The newly created application key with secret.
   */
  async createKey(
    apiUrl: string,
    authToken: string,
    request: CreateKeyRequest,
  ): Promise<FullApplicationKey> {
    return this.postJson<FullApplicationKey>(apiUrl, authToken, 'b2_create_key', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-keys | b2_list_keys}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The list of application keys and optional continuation token.
   */
  async listKeys(
    apiUrl: string,
    authToken: string,
    request: ListKeysRequest,
  ): Promise<ListKeysResponse> {
    return this.postJson<ListKeysResponse>(apiUrl, authToken, 'b2_list_keys', request)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-delete-key | b2_delete_key}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The deleted application key metadata.
   */
  async deleteKey(
    apiUrl: string,
    authToken: string,
    request: DeleteKeyRequest,
  ): Promise<ApplicationKey> {
    return this.postJson<ApplicationKey>(apiUrl, authToken, 'b2_delete_key', request)
  }

  // --- Retention / Legal Hold ---

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-update-file-retention | b2_update_file_retention}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The updated file retention settings.
   */
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-update-file-legal-hold | b2_update_file_legal_hold}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The updated file legal hold status.
   */
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-get-bucket-notification-rules | b2_get_bucket_notification_rules}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The configured event notification rules for the specified bucket.
   */
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

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-set-bucket-notification-rules | b2_set_bucket_notification_rules}.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param request - The API request parameters.
   *
   * @returns The updated bucket notification rules.
   */
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

  /**
   * Sends a JSON POST request to the specified B2 API endpoint.
   * @param apiUrl - The B2 API base URL.
   * @param authToken - The authorization token.
   * @param endpoint - The B2 API endpoint name.
   * @param body - The JSON request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async postJson<T>(
    apiUrl: string,
    authToken: string,
    endpoint: string,
    body: unknown,
    options?: RawRequestOptions,
  ): Promise<T> {
    const response = await this.transport.send({
      url: `${apiUrl}/b2api/v3/${endpoint}`,
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    })
    return response.json<T>()
  }
}

// --- Header helpers ---

import { EncryptionAlgorithm, EncryptionMode, type EncryptionSetting } from '../types/encryption.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'

/**
 * Applies server-side encryption headers to the request.
 * @param headers - The mutable headers object to populate.
 * @param encryption - The encryption settings, or undefined to skip.
 */
function applyEncryptionHeaders(
  headers: Record<string, string>,
  encryption: EncryptionSetting | undefined,
): void {
  if (!encryption || encryption.mode === EncryptionMode.None) return
  if (encryption.mode === EncryptionMode.SseB2) {
    headers['X-Bz-Server-Side-Encryption'] = EncryptionAlgorithm.Aes256
  } else if (encryption.mode === EncryptionMode.SseC) {
    headers['X-Bz-Server-Side-Encryption-Customer-Algorithm'] = EncryptionAlgorithm.Aes256
    headers['X-Bz-Server-Side-Encryption-Customer-Key'] = encryption.customerKey
    headers['X-Bz-Server-Side-Encryption-Customer-Key-Md5'] = encryption.customerKeyMd5
  }
}

/**
 * SSE-C decryption parameters supplied to downloads of files that were
 * uploaded with customer-managed keys.
 */
export interface SseCDownloadKey {
  /** Encryption algorithm. Always `EncryptionAlgorithm.Aes256` (`'AES256'`). */
  readonly algorithm: EncryptionAlgorithm
  /** Base64-encoded customer-provided decryption key. */
  readonly customerKey: string
  /** Base64-encoded MD5 digest of the decryption key. */
  readonly customerKeyMd5: string
}

/**
 * Options accepted by {@link RawClient.downloadFileById} and
 * {@link RawClient.downloadFileByName}. Mirrors the B2 native API: range +
 * SSE-C decryption headers + the documented `b2Content*` response-header
 * overrides (query-string parameters on the request URL).
 */
export interface DownloadFileOptions {
  /** HTTP method. Defaults to `'GET'`. Use `'HEAD'` to fetch headers without the body. */
  readonly method?: 'GET' | 'HEAD'
  /** HTTP Range header value for partial content requests. */
  readonly range?: string
  /** SSE-C decryption parameters, required if the file was uploaded with SSE-C. */
  readonly serverSideEncryption?: SseCDownloadKey
  /** Override the `Content-Disposition` header in the download response. */
  readonly b2ContentDisposition?: string
  /** Override the `Content-Language` header in the download response. */
  readonly b2ContentLanguage?: string
  /** Override the `Content-Encoding` header in the download response. */
  readonly b2ContentEncoding?: string
  /** Override the `Content-Type` header in the download response. */
  readonly b2ContentType?: string
  /** Override the `Cache-Control` header in the download response. */
  readonly b2CacheControl?: string
  /** Override the `Expires` header in the download response. */
  readonly b2Expires?: string
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
}

const DOWNLOAD_OVERRIDE_PARAMS = [
  'b2ContentDisposition',
  'b2ContentLanguage',
  'b2ContentEncoding',
  'b2ContentType',
  'b2CacheControl',
  'b2Expires',
] as const

/**
 * Builds the HTTP request headers for a download: Authorization, optional
 * Range, and optional SSE-C decryption headers.
 *
 * @param authToken - The B2 session authorization token.
 * @param options - Caller-supplied download options.
 *
 * @returns The header map to send with the request.
 */
function buildDownloadRequestHeaders(
  authToken: string,
  options: DownloadFileOptions | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { Authorization: authToken }
  if (options?.range) headers['Range'] = options.range
  if (options?.serverSideEncryption) {
    applyEncryptionHeaders(headers, {
      mode: EncryptionMode.SseC,
      ...options.serverSideEncryption,
    })
  }
  return headers
}

/**
 * Appends the documented `b2Content*` response-header overrides to a download
 * URL as query-string parameters. B2 echoes the values into the response
 * headers so callers can control content type, disposition, and caching.
 *
 * @param url - The base download URL.
 * @param options - Caller-supplied download options.
 *
 * @returns The URL with any override parameters appended.
 */
function appendDownloadOverrides(url: string, options: DownloadFileOptions | undefined): string {
  if (!options) return url
  const params: string[] = []
  for (const key of DOWNLOAD_OVERRIDE_PARAMS) {
    const value = options[key]
    if (value !== undefined) {
      params.push(`${key}=${encodeURIComponent(value)}`)
    }
  }
  if (params.length === 0) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}${params.join('&')}`
}

/**
 * Applies file retention headers to the request.
 * @param headers - The mutable headers object to populate.
 * @param retention - The retention settings, or undefined to skip.
 */
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

/**
 * Applies the legal hold header to the request.
 * @param headers - The mutable headers object to populate.
 * @param legalHold - The legal hold value, or undefined to skip.
 */
function applyLegalHoldHeader(
  headers: Record<string, string>,
  legalHold: LegalHoldValue | undefined,
): void {
  if (!legalHold) return
  headers['X-Bz-File-Legal-Hold'] = legalHold
}

export {
  buildFileInfoHeaders,
  decodeFileName,
  encodeFileName,
  parseFileInfoHeaders,
} from './encoding.ts'
