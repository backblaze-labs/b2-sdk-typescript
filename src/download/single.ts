import type { AccountInfo } from '../auth/account-info.js'
import { parseFileInfoHeaders } from '../raw/encoding.js'
import type { RawClient } from '../raw/index.js'
import type { DownloadHeaders } from '../types/download.js'
import type { FileId } from '../types/ids.js'

/** Result of a single-request file download. */
export interface DownloadResult {
  /** Parsed B2 response headers (content type, SHA-1, file info, etc.). */
  readonly headers: DownloadHeaders
  /** Streaming body of the downloaded file. */
  readonly body: ReadableStream<Uint8Array>
}

/** Options for downloading a file by its unique ID. */
export interface DownloadByIdOptions {
  /** ID of the file version to download. */
  readonly fileId: FileId
  /** Optional HTTP Range header value (e.g. `bytes=0-999`). */
  readonly range?: string
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
}

/** Options for downloading a file by bucket name and file path. */
export interface DownloadByNameOptions {
  /** Name of the bucket containing the file. */
  readonly bucketName: string
  /** Full file name (path) within the bucket. */
  readonly fileName: string
  /** Optional HTTP Range header value (e.g. `bytes=0-999`). */
  readonly range?: string
  /** Signal to abort the download. */
  readonly signal?: AbortSignal
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
    {
      ...(options.range !== undefined ? { range: options.range } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  )

  if (!resp.body) throw new Error('Download response has no body')

  return {
    headers: extractDownloadHeaders(resp.headers),
    body: resp.body,
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
    {
      ...(options.range !== undefined ? { range: options.range } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  )

  if (!resp.body) throw new Error('Download response has no body')

  return {
    headers: extractDownloadHeaders(resp.headers),
    body: resp.body,
  }
}

/** Extracts B2-specific download headers into a structured object. */
function extractDownloadHeaders(headers: Headers): DownloadHeaders {
  const fileInfo = parseFileInfoHeaders(headers)

  return {
    contentType: headers.get('Content-Type') ?? 'application/octet-stream',
    contentLength: Number.parseInt(headers.get('Content-Length') ?? '0', 10),
    contentSha1: headers.get('X-Bz-Content-Sha1'),
    fileId: (headers.get('X-Bz-File-Id') ?? '') as FileId,
    fileName: decodeURIComponent(headers.get('X-Bz-File-Name') ?? ''),
    fileInfo,
    uploadTimestamp: Number.parseInt(headers.get('X-Bz-Upload-Timestamp') ?? '0', 10),
  }
}
