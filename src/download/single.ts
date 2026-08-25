import type { AccountInfo } from '../auth/account-info.ts'
import { parseFileInfoHeaders } from '../raw/encoding.ts'
import type { DownloadFileOptions, RawClient, SseCDownloadKey } from '../raw/index.ts'
import { type ProgressListener, ProgressTracker } from '../streams/progress.ts'
import {
  DownloadClientUnauthorizedToReadMarker,
  DownloadHeaderName,
  type DownloadHeaderParseIssue,
  type DownloadHeaders,
  type DownloadServerSideEncryption,
} from '../types/download.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { type FileId, fileId as fileIdOf } from '../types/ids.ts'
import { type FileRetentionValue, LegalHoldValue, RetentionMode } from '../types/lock.ts'
import { bestEffort } from '../util/best-effort.ts'
import { normalizeSha1 } from '../util/normalize.ts'
import { verifyDownloadStream } from './checksum.ts'

/** Result of a single-request file download. */
export interface DownloadResult {
  /** Parsed B2 response headers (content type, SHA-1, file info, etc.). */
  readonly headers: DownloadHeaders
  /**
   * Streaming body of the downloaded file.
   *
   * If checksum verification fails, the stream errors after bytes have already
   * flowed; discard any partially written output on `ChecksumMismatchError`.
   */
  readonly body: ReadableStream<Uint8Array>
}

/**
 * Result of a HEAD-style metadata fetch. Unlike {@link DownloadResult},
 * this shape has **no** `body` field — the SDK consumes and discards the
 * (logically empty) HEAD response body internally so callers never have
 * to remember to `body.cancel()` after a metadata-only fetch.
 */
export interface HeadResult {
  /** Parsed B2 response headers (content type, SHA-1, file info, etc.). */
  readonly headers: DownloadHeaders
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
  /**
   * Callback invoked as bytes flow through the returned `body` stream.
   *
   * Wraps the response body so the SDK increments a `ProgressTracker` per
   * chunk and emits a `partsCompleted: 1` event when the stream finishes.
   * `totalBytes` is the response's `Content-Length`
   * header (or `null` if the server didn't send one — rare for B2).
   *
   * If the caller does not read the returned body to completion, the
   * tracker's `completePart()` event will not fire. That is intentional:
   * progress is byte-driven, not request-driven.
   */
  readonly onProgress?: ProgressListener
  /**
   * Minimum milliseconds between byte-only progress callbacks. Defaults to
   * the SDK's 100 ms progress interval; set to 0 for per-chunk callbacks.
   * The final completion callback is always emitted immediately.
   */
  readonly progressIntervalMillis?: number
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
 * Shared HEAD options. Mirrors {@link DownloadCommonOptions} but omits
 * `method` (always HEAD) and `onProgress` (no body to track).
 */
type HeadCommonOptions = Omit<
  DownloadCommonOptions,
  'method' | 'onProgress' | 'progressIntervalMillis'
>

/** Options for a HEAD-by-ID request. */
export interface HeadByIdOptions extends HeadCommonOptions {
  /** ID of the file version to inspect. */
  readonly fileId: FileId
}

/** Options for a HEAD-by-name request. */
export interface HeadByNameOptions extends HeadCommonOptions {
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
    options.fileId,
    toRawDownloadOptions(options),
  )

  const headers = extractDownloadHeaders(resp.headers)
  return {
    headers,
    // HEAD requests legitimately have no body; return an empty stream so the
    // result shape stays consistent.
    body: prepareDownloadBody(resp.body ?? emptyStream(), headers, options),
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

  const headers = extractDownloadHeaders(resp.headers)
  return {
    headers,
    body: prepareDownloadBody(resp.body ?? emptyStream(), headers, options),
  }
}

/**
 * Issues a HEAD-by-ID request and returns parsed headers only. Drains
 * the (logically empty) response body internally so callers don't have
 * to remember to `body.cancel()` themselves.
 *
 * Prefer this over `downloadById({ method: 'HEAD' })` — same wire-level
 * effect, but the caller-facing result has no `body` field at all so
 * there's nothing to clean up.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - HEAD parameters (file ID + the same response-header
 *   overrides and abort signal that `downloadById` accepts).
 *
 * @returns Parsed download headers (no body field).
 */
export async function headById(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: HeadByIdOptions,
): Promise<HeadResult> {
  const resp = await raw.downloadFileById(
    accountInfo.getDownloadUrl(),
    accountInfo.getAuthToken(),
    options.fileId,
    { ...toRawDownloadOptions(options), method: 'HEAD' },
  )
  // Body for HEAD is normally `null` per the fetch spec. Some transports
  // (notably the SDK's `B2Simulator`) synthesize a non-null body for
  // shape consistency. In either case, cancelling is a no-op for the
  // caller; wrap in `bestEffort` so a stream-lifecycle quirk in a
  // future runtime can't fail an otherwise-successful HEAD.
  if (resp.body !== null) {
    // Bind to a local so the type narrowing carries into the closure;
    // bare `resp.body` in the lambda would re-broaden to `... | null`.
    const body = resp.body
    await bestEffort(() => body.cancel())
  }
  return { headers: extractDownloadHeaders(resp.headers) }
}

/**
 * Issues a HEAD-by-name request and returns parsed headers only. Drains
 * the (logically empty) response body internally so callers don't have
 * to remember to `body.cancel()` themselves.
 *
 * Prefer this over `downloadByName({ method: 'HEAD' })` — same wire-level
 * effect, but the caller-facing result has no `body` field at all so
 * there's nothing to clean up.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param options - HEAD parameters (bucket + file name + the same
 *   response-header overrides and abort signal that `downloadByName`
 *   accepts).
 *
 * @returns Parsed download headers (no body field).
 */
export async function headByName(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: HeadByNameOptions,
): Promise<HeadResult> {
  const resp = await raw.downloadFileByName(
    accountInfo.getDownloadUrl(),
    accountInfo.getAuthToken(),
    options.bucketName,
    options.fileName,
    { ...toRawDownloadOptions(options), method: 'HEAD' },
  )
  if (resp.body !== null) {
    // Bind to a local so the type narrowing carries into the closure;
    // bare `resp.body` in the lambda would re-broaden to `... | null`.
    const body = resp.body
    await bestEffort(() => body.cancel())
  }
  return { headers: extractDownloadHeaders(resp.headers) }
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
 * Applies stream wrappers common to single-request downloads.
 *
 * Full-body GET downloads are checksum-verified when B2 supplies a real
 * whole-file SHA-1. HEAD requests and ranged GETs are skipped because the
 * response body is empty or partial while `X-Bz-Content-Sha1` describes the
 * full file version.
 *
 * @param body - Download response body.
 * @param headers - Parsed download headers.
 * @param options - Caller-supplied download options.
 *
 * @returns A stream wrapped for checksum verification and progress reporting.
 */
function prepareDownloadBody(
  body: ReadableStream<Uint8Array>,
  headers: DownloadHeaders,
  options: DownloadCommonOptions,
): ReadableStream<Uint8Array> {
  const shouldVerify = options.method !== 'HEAD' && options.range === undefined
  const verifiedBody = shouldVerify ? verifyDownloadStream(body, headers.contentSha1) : body
  return instrumentProgress(
    verifiedBody,
    headers.contentLength,
    options.onProgress,
    options.progressIntervalMillis,
  )
}

/**
 * Wraps a body stream so the SDK increments a {@link ProgressTracker} for
 * each chunk and reports `partsCompleted: 1` when the stream finishes.
 *
 * When `listener` is undefined the function short-circuits and returns
 * the original stream, so unobserved downloads pay no overhead.
 *
 * @param body - The download response body to wrap.
 * @param totalBytes - Expected total bytes (response `Content-Length`).
 * @param listener - Caller-supplied progress callback, or undefined.
 * @param progressIntervalMillis - Optional byte-progress throttle interval.
 *
 * @returns A stream that emits the same bytes and reports progress.
 */
function instrumentProgress(
  body: ReadableStream<Uint8Array>,
  totalBytes: number,
  listener: ProgressListener | undefined,
  progressIntervalMillis: number | undefined,
): ReadableStream<Uint8Array> {
  if (listener === undefined) return body
  const tracker = new ProgressTracker(listener, totalBytes, 1, {
    ...(progressIntervalMillis !== undefined ? { minIntervalMs: progressIntervalMillis } : {}),
  })
  const reader = body.getReader()
  let released = false

  function releaseReader(): void {
    /* v8 ignore next -- the wrapper releases exactly once from mutually exclusive stream paths */
    if (released) return
    released = true
    reader.releaseLock()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          tracker.completePart()
          tracker.dispose()
          releaseReader()
          controller.close()
          return
        }
        tracker.addBytes(value.byteLength)
        controller.enqueue(value)
      } catch (err) {
        tracker.dispose()
        releaseReader()
        throw err
      }
    },
    async cancel(reason) {
      tracker.dispose()
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
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
  const headerParseIssues: DownloadHeaderParseIssue[] = []
  const fileInfo = parseFileInfoHeaders(headers)
  const clientUnauthorizedToRead = parseClientUnauthorizedToRead(headers, headerParseIssues)
  const contentDisposition = optionalHeader(headers, DownloadHeaderName.ContentDisposition)
  const contentLanguage = optionalHeader(headers, DownloadHeaderName.ContentLanguage)
  const contentEncoding = optionalHeader(headers, DownloadHeaderName.ContentEncoding)
  const cacheControl = optionalHeader(headers, DownloadHeaderName.CacheControl)
  const expires = optionalHeader(headers, DownloadHeaderName.Expires)
  const contentRange = optionalHeader(headers, DownloadHeaderName.ContentRange)
  const serverSideEncryption = parseDownloadServerSideEncryption(headers, headerParseIssues)
  const fileRetention = parseDownloadFileRetention(
    headers,
    clientUnauthorizedToRead,
    headerParseIssues,
  )
  const legalHold = parseDownloadLegalHold(headers, clientUnauthorizedToRead, headerParseIssues)

  return {
    contentType: headers.get(DownloadHeaderName.ContentType) ?? 'application/octet-stream',
    contentLength: Number.parseInt(headers.get(DownloadHeaderName.ContentLength) ?? '0', 10),
    ...(contentDisposition !== undefined ? { contentDisposition } : {}),
    ...(contentLanguage !== undefined ? { contentLanguage } : {}),
    ...(contentEncoding !== undefined ? { contentEncoding } : {}),
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(contentRange !== undefined ? { contentRange } : {}),
    // B2 sends the literal `'none'` for multipart-finished files; collapse
    // to `null` so the typed `string | null` actually means "no SHA-1".
    contentSha1: normalizeSha1(headers.get(DownloadHeaderName.ContentSha1)),
    fileId: fileIdOf(headers.get(DownloadHeaderName.FileId) ?? ''),
    fileName: decodeURIComponent(headers.get(DownloadHeaderName.FileName) ?? ''),
    fileInfo,
    uploadTimestamp: Number.parseInt(headers.get(DownloadHeaderName.UploadTimestamp) ?? '0', 10),
    ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
    ...(fileRetention !== undefined ? { fileRetention } : {}),
    ...(legalHold !== undefined ? { legalHold } : {}),
    ...(clientUnauthorizedToRead !== undefined ? { clientUnauthorizedToRead } : {}),
    ...(headerParseIssues.length > 0 ? { headerParseIssues } : {}),
  }
}

function optionalHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined
}

function parseDownloadServerSideEncryption(
  headers: Headers,
  headerParseIssues: DownloadHeaderParseIssue[],
): DownloadServerSideEncryption | undefined {
  const managedAlgorithm = optionalHeader(headers, DownloadHeaderName.ServerSideEncryption)
  if (managedAlgorithm !== undefined) {
    if (managedAlgorithm !== EncryptionAlgorithm.Aes256) {
      headerParseIssues.push({
        headerName: DownloadHeaderName.ServerSideEncryption,
        value: managedAlgorithm,
      })
      return undefined
    }
    return { mode: EncryptionMode.SseB2, algorithm: managedAlgorithm }
  }

  const customerAlgorithm = optionalHeader(
    headers,
    DownloadHeaderName.ServerSideEncryptionCustomerAlgorithm,
  )
  const customerKeyMd5 = optionalHeader(
    headers,
    DownloadHeaderName.ServerSideEncryptionCustomerKeyMd5,
  )
  if (customerAlgorithm === undefined || customerKeyMd5 === undefined) return undefined
  if (customerAlgorithm !== EncryptionAlgorithm.Aes256) {
    headerParseIssues.push({
      headerName: DownloadHeaderName.ServerSideEncryptionCustomerAlgorithm,
      value: customerAlgorithm,
    })
    return undefined
  }
  return { mode: EncryptionMode.SseC, algorithm: customerAlgorithm, customerKeyMd5 }
}

function parseDownloadFileRetention(
  headers: Headers,
  clientUnauthorizedToRead: DownloadHeaders['clientUnauthorizedToRead'],
  headerParseIssues: DownloadHeaderParseIssue[],
): DownloadHeaders['fileRetention'] {
  if (
    clientUnauthorizedToRead?.includes(DownloadClientUnauthorizedToReadMarker.FileRetentionMode) ===
      true ||
    clientUnauthorizedToRead?.includes(
      DownloadClientUnauthorizedToReadMarker.FileRetentionRetainUntilTimestamp,
    ) === true
  ) {
    return { isClientAuthorizedToRead: false, value: null }
  }

  const rawMode = optionalHeader(headers, DownloadHeaderName.FileRetentionMode)
  const rawRetainUntilTimestamp = optionalHeader(
    headers,
    DownloadHeaderName.FileRetentionRetainUntilTimestamp,
  )
  if (rawMode === undefined && rawRetainUntilTimestamp === undefined) return undefined
  return {
    isClientAuthorizedToRead: true,
    value: {
      mode: parseRetentionMode(rawMode, headerParseIssues),
      retainUntilTimestamp: parseRetentionTimestamp(rawRetainUntilTimestamp, headerParseIssues),
    },
  }
}

function parseRetentionMode(
  rawMode: string | undefined,
  headerParseIssues: DownloadHeaderParseIssue[],
): FileRetentionValue['mode'] {
  if (rawMode === undefined) return null
  if (rawMode === RetentionMode.Compliance || rawMode === RetentionMode.Governance) {
    return rawMode
  }
  headerParseIssues.push({ headerName: DownloadHeaderName.FileRetentionMode, value: rawMode })
  return null
}

function parseRetentionTimestamp(
  rawTimestamp: string | undefined,
  headerParseIssues: DownloadHeaderParseIssue[],
): number | null {
  if (rawTimestamp === undefined) return null
  if (!/^\d+$/.test(rawTimestamp)) {
    headerParseIssues.push({
      headerName: DownloadHeaderName.FileRetentionRetainUntilTimestamp,
      value: rawTimestamp,
    })
    return null
  }
  const parsed = Number.parseInt(rawTimestamp, 10)
  if (Number.isFinite(parsed)) return parsed
  headerParseIssues.push({
    headerName: DownloadHeaderName.FileRetentionRetainUntilTimestamp,
    value: rawTimestamp,
  })
  return null
}

function parseDownloadLegalHold(
  headers: Headers,
  clientUnauthorizedToRead: DownloadHeaders['clientUnauthorizedToRead'],
  headerParseIssues: DownloadHeaderParseIssue[],
): DownloadHeaders['legalHold'] {
  if (clientUnauthorizedToRead?.includes(DownloadClientUnauthorizedToReadMarker.FileLegalHold)) {
    return { isClientAuthorizedToRead: false, value: null }
  }

  const rawLegalHold = optionalHeader(headers, DownloadHeaderName.FileLegalHold)
  if (rawLegalHold === undefined) return undefined
  if (rawLegalHold === LegalHoldValue.On || rawLegalHold === LegalHoldValue.Off) {
    return { isClientAuthorizedToRead: true, value: rawLegalHold }
  }
  headerParseIssues.push({ headerName: DownloadHeaderName.FileLegalHold, value: rawLegalHold })
  return { isClientAuthorizedToRead: true, value: null }
}

function parseClientUnauthorizedToRead(
  headers: Headers,
  headerParseIssues: DownloadHeaderParseIssue[],
): DownloadHeaders['clientUnauthorizedToRead'] {
  const value = optionalHeader(headers, DownloadHeaderName.ClientUnauthorizedToRead)
  if (value === undefined) return undefined
  const headerNames = value
    .split(',')
    .map((header) => header.trim())
    .filter((header) => header.length > 0)
  const knownHeaderNames = headerNames.filter(isDownloadClientUnauthorizedToReadMarker)
  for (const headerName of headerNames) {
    if (!isDownloadClientUnauthorizedToReadMarker(headerName)) {
      headerParseIssues.push({
        headerName: DownloadHeaderName.ClientUnauthorizedToRead,
        value: headerName,
      })
    }
  }
  return knownHeaderNames.length > 0 ? knownHeaderNames : undefined
}

function isDownloadClientUnauthorizedToReadMarker(
  headerName: string,
): headerName is DownloadClientUnauthorizedToReadMarker {
  return Object.values(DownloadClientUnauthorizedToReadMarker).includes(
    headerName as DownloadClientUnauthorizedToReadMarker,
  )
}
