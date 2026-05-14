import type { AccountInfo } from '../auth/account-info.ts'
import { parseFileInfoHeaders } from '../raw/encoding.ts'
import type { DownloadFileOptions, RawClient, SseCDownloadKey } from '../raw/index.ts'
import type { DownloadHeaders } from '../types/download.ts'
import { type FileId, fileId as fileIdOf } from '../types/ids.ts'

/** Result of a single-request file download. */
export interface DownloadResult {
  /** Parsed B2 response headers (content type, SHA-1, file info, etc.). */
  readonly headers: DownloadHeaders
  /** Streaming body of the downloaded file. */
  readonly body: ReadableStream<Uint8Array>
}

/** Shared download options exposed at the high-level facade. */
interface DownloadCommonOptions {
  /** HTTP method. Defaults to `'GET'`. Use `'HEAD'` to fetch only response headers without streaming the body. */
  readonly method?: 'GET' | 'HEAD'
  /** Optional HTTP Range header value (e.g. `bytes=0-999`). */
  readonly range?: string
  /** SSE-C decryption parameters, required if the file was uploaded with SSE-C. */
  readonly serverSideEncryption?: SseCDownloadKey
  /** Override the response `Content-Disposition` header. */
  readonly b2ContentDisposition?: string
  /** Override the response `Content-Language` header. */
  readonly b2ContentLanguage?: string
  /** Override the response `Content-Encoding` header. */
  readonly b2ContentEncoding?: string
  /** Override the response `Content-Type` header. */
  readonly b2ContentType?: string
  /** Override the response `Cache-Control` header. */
  readonly b2CacheControl?: string
  /** Override the response `Expires` header. */
  readonly b2Expires?: string
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
}

/** Options for downloading a file by its unique ID. */
export interface DownloadByIdOptions extends DownloadCommonOptions {
  /** ID of the file version to download. */
  readonly fileId: FileId
}

/** Options for downloading a file by bucket name and file path. */
export interface DownloadByNameOptions extends DownloadCommonOptions {
  /** Name of the bucket containing the file. */
  readonly bucketName: string
  /** Full file name (path) within the bucket. */
  readonly fileName: string
}

/**
 * Downloads a file by its unique ID in a single HTTP request.
 *
 * Returns a streaming body suitable for small-to-medium files. For large files
 * that benefit from concurrent ranged fetches, use
 * {@link createParallelDownloadStream} instead.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - Download parameters.
 *
 * @returns Parsed headers and a readable stream of file bytes.
 */
export async function downloadById(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: DownloadByIdOptions,
): Promise<DownloadResult> {
  const resp = await raw.downloadFileById(
    accountInfo.getDownloadUrl(),
    accountInfo.getAuthToken(),
    options.fileId as string,
    toRawDownloadOptions(options),
  )

  return {
    headers: extractDownloadHeaders(resp.headers),
    // HEAD requests legitimately have no body; return an empty stream so the
    // result shape stays consistent.
    body: resp.body ?? emptyStream(),
  }
}

/**
 * Downloads a file by bucket name and file path in a single HTTP request.
 *
 * Returns a streaming body suitable for small-to-medium files. For large files
 * that benefit from concurrent ranged fetches, use
 * {@link createParallelDownloadStream} instead.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - Download parameters.
 *
 * @returns Parsed headers and a readable stream of file bytes.
 */
export async function downloadByName(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: DownloadByNameOptions,
): Promise<DownloadResult> {
  const resp = await raw.downloadFileByName(
    accountInfo.getDownloadUrl(),
    accountInfo.getAuthToken(),
    options.bucketName,
    options.fileName,
    toRawDownloadOptions(options),
  )

  return {
    headers: extractDownloadHeaders(resp.headers),
    body: resp.body ?? emptyStream(),
  }
}

/**
 * Translates the public download-options shape into the raw client's
 * {@link DownloadFileOptions}, dropping the request-target fields (`fileId`,
 * `bucketName`, `fileName`) that don't apply at the transport layer.
 *
 * @param options - Caller-supplied download options.
 *
 * @returns The raw transport-layer options.
 */
function toRawDownloadOptions(options: DownloadCommonOptions): DownloadFileOptions {
  return {
    ...(options.method !== undefined ? { method: options.method } : {}),
    ...(options.range !== undefined ? { range: options.range } : {}),
    ...(options.serverSideEncryption !== undefined
      ? { serverSideEncryption: options.serverSideEncryption }
      : {}),
    ...(options.b2ContentDisposition !== undefined
      ? { b2ContentDisposition: options.b2ContentDisposition }
      : {}),
    ...(options.b2ContentLanguage !== undefined
      ? { b2ContentLanguage: options.b2ContentLanguage }
      : {}),
    ...(options.b2ContentEncoding !== undefined
      ? { b2ContentEncoding: options.b2ContentEncoding }
      : {}),
    ...(options.b2ContentType !== undefined ? { b2ContentType: options.b2ContentType } : {}),
    ...(options.b2CacheControl !== undefined ? { b2CacheControl: options.b2CacheControl } : {}),
    ...(options.b2Expires !== undefined ? { b2Expires: options.b2Expires } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }
}

/**
 * Builds an immediately-closed empty ReadableStream. Used as the body of a
 * HEAD download response so callers always get a stream they can `pipeTo`.
 *
 * @returns A ReadableStream that yields zero bytes and immediately closes.
 */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

/**
 * Extracts B2-specific download headers into a structured object.
 * @param headers - The HTTP response headers from the download.
 *
 * @returns The parsed download metadata.
 */
function extractDownloadHeaders(headers: Headers): DownloadHeaders {
  const fileInfo = parseFileInfoHeaders(headers)

  return {
    contentType: headers.get('Content-Type') ?? 'application/octet-stream',
    contentLength: Number.parseInt(headers.get('Content-Length') ?? '0', 10),
    contentSha1: headers.get('X-Bz-Content-Sha1'),
    fileId: fileIdOf(headers.get('X-Bz-File-Id') ?? ''),
    fileName: decodeURIComponent(headers.get('X-Bz-File-Name') ?? ''),
    fileInfo,
    uploadTimestamp: Number.parseInt(headers.get('X-Bz-Upload-Timestamp') ?? '0', 10),
  }
}
