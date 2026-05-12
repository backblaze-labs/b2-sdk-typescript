import type { AccountInfo } from '../auth/account-info.js'
import { parseFileInfoHeaders } from '../raw/encoding.js'
import type { RawClient } from '../raw/index.js'
import type { DownloadHeaders } from '../types/download.js'
import type { FileId } from '../types/ids.js'

export interface DownloadResult {
  readonly headers: DownloadHeaders
  readonly body: ReadableStream<Uint8Array>
}

export interface DownloadByIdOptions {
  readonly fileId: FileId
  readonly range?: string
  readonly signal?: AbortSignal
}

export interface DownloadByNameOptions {
  readonly bucketName: string
  readonly fileName: string
  readonly range?: string
  readonly signal?: AbortSignal
}

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
