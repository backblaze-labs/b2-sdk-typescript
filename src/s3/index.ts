/**
 * S3-compatible helpers for using B2 with the AWS SDK and S3 clients.
 *
 * Provides {@link createS3ClientConfig} to derive endpoint, region, and
 * credentials from B2 authorization state, plus {@link presignS3GetObjectUrl}
 * and {@link presignPutObjectUrl} for generating AWS Signature Version 4
 * presigned URLs against B2's S3-compatible API.
 *
 * @packageDocumentation
 */

import type { AccountInfo } from '../auth/account-info.ts'
import { encodeFileName } from '../raw/encoding.ts'

const DEFAULT_PRESIGN_EXPIRES_IN = 3600
const MAX_PRESIGN_EXPIRES_IN = 604_800
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
const HTTP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const textEncoder = new TextEncoder()

/**
 * Configuration for deriving S3-compatible client settings from B2 auth state.
 *
 * Per B2's S3-compatible API contract, the S3 `accessKeyId` is the
 * `applicationKeyId` and the S3 `secretAccessKey` is the
 * `applicationKey`. These are NOT the native `accountId` /
 * `authorizationToken` returned by `b2_authorize_account` — those won't
 * authenticate against the S3 endpoint. Both must be supplied here
 * because `AccountInfo` doesn't retain the application key after
 * authorization for security reasons.
 *
 * @see https://www.backblaze.com/apidocs/s3-compatible-api
 */
export interface B2S3Config {
  /** The authorized AccountInfo containing the S3 endpoint URL. */
  readonly accountInfo: AccountInfo
  /** B2 application key ID. Used as the S3 `accessKeyId`. */
  readonly applicationKeyId: string
  /** B2 application key (secret). Used as the S3 `secretAccessKey`. */
  readonly applicationKey: string
  /** Override the S3 region. If omitted, extracted from the S3 API URL. */
  readonly region?: string
}

/** Configuration object compatible with `@aws-sdk/client-s3`'s S3Client constructor. */
export interface S3ClientConfig {
  /** The S3-compatible endpoint URL (e.g., `https://s3.us-west-004.backblazeb2.com`). */
  readonly endpoint: string
  /** The S3 region identifier (e.g., `us-west-004`). */
  readonly region: string
  /** AWS-style credentials — the B2 application key pair. */
  readonly credentials: {
    /** The B2 application key ID, used as the S3 access key ID. */
    readonly accessKeyId: string
    /** The B2 application key (secret), used as the S3 secret access key. */
    readonly secretAccessKey: string
  }
  /** Always `true` for B2, which requires path-style bucket addressing. */
  readonly forcePathStyle: boolean
}

/** Date input accepted by the internal SigV4 presigner. */
export type S3PresignDate = Date | number | string

/** Common options for S3-compatible presigned object URLs. */
export interface S3PresignObjectUrlOptions extends B2S3Config {
  /** Bucket containing the object. */
  readonly bucketName: string
  /** Object key / B2 file name to sign. */
  readonly fileName: string
  /**
   * URL validity duration in seconds. Defaults to 3600. Must be an integer
   * from 1 to 604800 (7 days), the AWS Signature Version 4 presign maximum.
   * A presigned URL is a bearer credential for the signed operation; keep
   * this as short as the calling workflow allows.
   */
  readonly expiresIn?: number
  /** Optional signing clock override, primarily useful for deterministic tests. */
  readonly signingDate?: S3PresignDate
}

/** Options for {@link presignS3GetObjectUrl}. */
export interface PresignS3GetObjectUrlOptions extends S3PresignObjectUrlOptions {
  /** Optional S3 version ID to include in the signed GET request. */
  readonly versionId?: string
  /**
   * Override the response Cache-Control header. Response overrides control
   * headers served from the storage origin; do not populate them from
   * untrusted input without an allow-list.
   */
  readonly responseCacheControl?: string
  /**
   * Override the response Content-Disposition header. Prefer a safe
   * attachment disposition when this value can be influenced by users.
   */
  readonly responseContentDisposition?: string
  /**
   * Override the response Content-Encoding header. Do not populate this from
   * untrusted input without an allow-list.
   */
  readonly responseContentEncoding?: string
  /**
   * Override the response Content-Language header. Do not populate this from
   * untrusted input without an allow-list.
   */
  readonly responseContentLanguage?: string
  /**
   * Override the response Content-Type header. If attacker-controlled, this
   * can make stored bytes render as HTML/script from the storage origin.
   * Restrict it to known-safe values before signing.
   */
  readonly responseContentType?: string
  /**
   * Override the response Expires header. Do not populate this from
   * untrusted input without an allow-list.
   */
  readonly responseExpires?: Date
}

/** Backward-compatible alias for the S3 SigV4 GET helper options. */
export type PresignGetObjectUrlOptions = PresignS3GetObjectUrlOptions

/** Options for {@link presignPutObjectUrl}. */
export interface PresignPutObjectUrlOptions extends S3PresignObjectUrlOptions {
  /**
   * Optional content type for the uploaded object. When supplied, the generated
   * URL signs the Content-Type header, so upload clients must send the same value.
   */
  readonly contentType?: string
  /**
   * Optional content length. Must be a non-negative safe integer. When
   * supplied, the generated URL signs the Content-Length header, so upload
   * clients must send the same value.
   */
  readonly contentLength?: number
  /**
   * Optional user metadata to attach to the object. The generated URL signs
   * matching `x-amz-meta-*` headers, so upload clients must send the same values.
   * Metadata keys must be valid HTTP header tokens and must not differ only by
   * case.
   */
  readonly metadata?: Record<string, string>
}

/**
 * Derives an S3-compatible client configuration from B2 authorization state.
 * Pass the result to `new S3Client(config)` from `@aws-sdk/client-s3`.
 *
 * Non-standard, custom, or proxied endpoints require an explicit `region`; the
 * SDK no longer falls back to `us-west-004` because that can mis-sign requests.
 *
 * @param config - B2 auth state, application key credentials, and optional region override.
 *
 * @returns Configuration ready for the AWS S3 SDK.
 *
 * @example
 * ```ts
 * const { B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY } = process.env
 * if (!B2_APPLICATION_KEY_ID || !B2_APPLICATION_KEY) throw new Error('Missing B2 credentials')
 * const s3 = new S3Client(createS3ClientConfig({
 *   accountInfo: client.accountInfo,
 *   applicationKeyId: B2_APPLICATION_KEY_ID,
 *   applicationKey: B2_APPLICATION_KEY,
 * }))
 * ```
 */
export function createS3ClientConfig(config: B2S3Config): S3ClientConfig {
  const s3Url = config.accountInfo.getS3ApiUrl()
  const region = config.region ?? deriveRequiredS3Region(s3Url)

  return {
    endpoint: s3Url,
    region,
    credentials: {
      accessKeyId: config.applicationKeyId,
      secretAccessKey: config.applicationKey,
    },
    forcePathStyle: true,
  }
}

/**
 * Extracts the B2 S3 region from a standard B2 S3 endpoint.
 *
 * Custom endpoints cannot be inferred safely. Pass `region` explicitly to
 * {@link createS3ClientConfig}, {@link presignS3GetObjectUrl}, or
 * {@link presignPutObjectUrl} when this returns `null`.
 *
 * @param endpoint - The S3 endpoint URL.
 *
 * @returns The derived region, or `null` when the endpoint is not a standard B2 S3 URL.
 */
export function deriveS3RegionFromEndpoint(endpoint: string): string | null {
  let hostname: string
  try {
    hostname = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return null
  }

  const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(hostname)
  return match?.[1] ?? null
}

/**
 * Generates an AWS Signature Version 4 presigned GET URL for B2's S3-compatible API.
 *
 * This helper signs internally and does not pass the B2 application key to
 * runtime peer dependencies. Response override options are signed into the URL
 * and control headers served from the storage origin; do not populate them from
 * untrusted input without an allow-list.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignS3GetObjectUrl(
  options: PresignS3GetObjectUrlOptions,
): Promise<string> {
  const query: QueryParam[] = [['x-id', 'GetObject']]
  if (options.versionId !== undefined) query.push(['versionId', options.versionId])
  if (options.responseCacheControl !== undefined) {
    query.push(['response-cache-control', options.responseCacheControl])
  }
  if (options.responseContentDisposition !== undefined) {
    query.push(['response-content-disposition', options.responseContentDisposition])
  }
  if (options.responseContentEncoding !== undefined) {
    query.push(['response-content-encoding', options.responseContentEncoding])
  }
  if (options.responseContentLanguage !== undefined) {
    query.push(['response-content-language', options.responseContentLanguage])
  }
  if (options.responseContentType !== undefined) {
    query.push(['response-content-type', options.responseContentType])
  }
  if (options.responseExpires !== undefined) {
    query.push(['response-expires', options.responseExpires.toUTCString()])
  }

  return await presignS3Request('GET', options, query, [])
}

/**
 * Backward-compatible B2-native download authorization URL helper.
 *
 * @param downloadUrl - The B2 download URL from authorization.
 * @param bucketName - The bucket containing the file.
 * @param fileName - The file name (path) to download.
 * @param authorizationToken - A download authorization token from `b2_get_download_authorization`.
 * @param validDurationInSeconds - Compatibility-only value for the non-authoritative `expires` query.
 *
 * @returns The B2 native download-authorization URL string.
 *
 * @deprecated Use {@link createNativeDownloadAuthorizationUrl} for B2 native
 * download-token URLs, or {@link presignS3GetObjectUrl} for real S3-compatible
 * AWS Signature Version 4 presigned GET URLs.
 */
export function presignGetObjectUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
  validDurationInSeconds?: number,
): string {
  return createNativeDownloadAuthorizationUrl(
    downloadUrl,
    bucketName,
    fileName,
    authorizationToken,
    validDurationInSeconds,
  )
}

/**
 * Generates an AWS Signature Version 4 presigned PUT URL for browser or third-party uploads
 * through B2's S3-compatible API.
 *
 * This helper signs internally and does not pass the B2 application key to
 * runtime peer dependencies. A presigned PUT URL is a bearer credential for
 * writing one key. If `contentType` and `contentLength` are omitted, the holder
 * can choose any content type and size accepted by B2; bind both values before
 * handing URLs to untrusted uploaders to limit financial-DoS and content-type
 * smuggling risk.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignPutObjectUrl(options: PresignPutObjectUrlOptions): Promise<string> {
  const headers: SignedHeader[] = []
  if (options.contentType !== undefined) {
    headers.push(['content-type', options.contentType])
  }
  if (options.contentLength !== undefined) {
    headers.push(['content-length', normalizeContentLength(options.contentLength)])
  }
  headers.push(...normalizeMetadataHeaders(options.metadata))

  return await presignS3Request('PUT', options, [['x-id', 'PutObject']], headers)
}

/**
 * Constructs a B2-native download URL using a token from `b2_get_download_authorization`.
 * This is not an S3 presigned URL.
 *
 * The token lifetime is fixed when `b2_get_download_authorization` creates the
 * token. `validDurationInSeconds` is retained only for compatibility with the
 * legacy `presignGetObjectUrl` helper's decorative `expires` query parameter;
 * changing it here does not shorten or extend access.
 *
 * @param downloadUrl - The B2 download URL from authorization (e.g., `https://f004.backblazeb2.com`).
 * @param bucketName - The bucket containing the file.
 * @param fileName - The file name (path) to download.
 * @param authorizationToken - A download authorization token from `b2_get_download_authorization`.
 * @param validDurationInSeconds - Compatibility-only value for the non-authoritative `expires` query.
 *
 * @returns The B2 native download-authorization URL string, not an S3 presigned URL.
 */
export function createNativeDownloadAuthorizationUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
  validDurationInSeconds = DEFAULT_PRESIGN_EXPIRES_IN,
): string {
  const expires = Math.floor(Date.now() / 1000) + validDurationInSeconds
  return `${downloadUrl}/file/${awsPercentEncode(bucketName)}/${encodeFileName(fileName)}?Authorization=${awsPercentEncode(authorizationToken)}&expires=${expires}`
}

type QueryParam = readonly [name: string, value: string]
type SignedHeader = readonly [name: string, value: string]

async function presignS3Request(
  method: 'GET' | 'PUT',
  options: S3PresignObjectUrlOptions,
  extraQuery: QueryParam[],
  extraHeaders: SignedHeader[],
): Promise<string> {
  const clientConfig = createS3ClientConfig(options)
  const endpoint = new URL(clientConfig.endpoint)
  const region = clientConfig.region
  const expiresIn = normalizeExpiresIn(options.expiresIn)
  const { shortDate, longDate } = formatSigningDate(options.signingDate)
  const credentialScope = `${shortDate}/${region}/${SERVICE}/${TERMINATOR}`
  const credential = `${options.applicationKeyId}/${credentialScope}`
  const canonicalUri = buildCanonicalUri(endpoint.pathname, options.bucketName, options.fileName)
  const headers = normalizeSignedHeaders([['host', endpoint.host], ...extraHeaders])
  const signedHeaders = headers.map(([name]) => name).join(';')

  const query: QueryParam[] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', UNSIGNED_PAYLOAD],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', longDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', signedHeaders],
    ...extraQuery,
  ]
  const canonicalQuery = canonicalQueryString(query)
  const canonicalHeaders = headers.map(([name, value]) => `${name}:${value}\n`).join('')
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    longDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = await deriveSigningKey(options.applicationKey, shortDate, region)
  const signature = toHex(await hmacSha256(signingKey, stringToSign))
  const finalQuery = canonicalQueryString([...query, ['X-Amz-Signature', signature]])

  return `${endpoint.origin}${canonicalUri}?${finalQuery}`
}

function deriveRequiredS3Region(endpoint: string): string {
  const region = deriveS3RegionFromEndpoint(endpoint)
  if (region !== null) return region

  throw new Error(
    `Unable to derive B2 S3 region from endpoint "${endpoint}". Pass an explicit region.`,
  )
}

function normalizeExpiresIn(expiresIn: number | undefined): number {
  const value = expiresIn ?? DEFAULT_PRESIGN_EXPIRES_IN
  if (!Number.isInteger(value) || value < 1 || value > MAX_PRESIGN_EXPIRES_IN) {
    throw new RangeError(
      `expiresIn must be an integer from 1 to ${MAX_PRESIGN_EXPIRES_IN} seconds.`,
    )
  }
  return value
}

function normalizeContentLength(contentLength: number): string {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new RangeError('contentLength must be a non-negative safe integer.')
  }

  return String(contentLength)
}

function normalizeMetadataHeaders(metadata: Record<string, string> | undefined): SignedHeader[] {
  const headers: SignedHeader[] = []
  const seenKeys = new Set<string>()

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!HTTP_HEADER_TOKEN.test(key)) {
      throw new TypeError('metadata keys must be non-empty valid HTTP header tokens.')
    }

    const lowerKey = key.toLowerCase()
    if (seenKeys.has(lowerKey)) {
      throw new TypeError('metadata keys must not differ only by case.')
    }

    seenKeys.add(lowerKey)
    headers.push([`x-amz-meta-${lowerKey}`, value])
  }

  return headers
}

function formatSigningDate(input: S3PresignDate | undefined): {
  readonly shortDate: string
  readonly longDate: string
} {
  const date = input === undefined ? new Date() : new Date(input)
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('signingDate must be a valid Date, timestamp, or date string.')
  }

  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  const shortDate = `${year}${month}${day}`
  return {
    shortDate,
    longDate: `${shortDate}T${hour}${minute}${second}Z`,
  }
}

function buildCanonicalUri(endpointPath: string, bucketName: string, fileName: string): string {
  const basePath =
    endpointPath === '' || endpointPath === '/' ? '' : endpointPath.replace(/\/+$/, '')
  return `${basePath}/${encodePathSegment(bucketName)}/${encodePath(fileName)}`
}

function encodePath(path: string): string {
  return path.split('/').map(encodePathSegment).join('/')
}

function encodePathSegment(segment: string): string {
  return awsPercentEncode(segment)
}

function canonicalQueryString(query: readonly QueryParam[]): string {
  return query
    .map(([name, value]) => [awsPercentEncode(name), awsPercentEncode(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => {
      if (aName < bName) return -1
      if (aName > bName) return 1
      if (aValue < bValue) return -1
      if (aValue > bValue) return 1
      return 0
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function normalizeSignedHeaders(headers: readonly SignedHeader[]): SignedHeader[] {
  return headers
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([a], [b]) => {
      if (a < b) return -1
      if (a > b) return 1
      return 0
    })
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

async function deriveSigningKey(
  secretAccessKey: string,
  shortDate: string,
  region: string,
): Promise<Uint8Array> {
  const dateKey = await hmacSha256(textEncoder.encode(`AWS4${secretAccessKey}`), shortDate)
  const dateRegionKey = await hmacSha256(dateKey, region)
  const dateRegionServiceKey = await hmacSha256(dateRegionKey, SERVICE)
  return await hmacSha256(dateRegionServiceKey, TERMINATOR)
}

async function sha256Hex(data: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      arrayBufferFor(textEncoder.encode(data)),
    )
    return toHex(new Uint8Array(digest))
  }

  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(data).digest('hex')
}

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'raw',
      arrayBufferFor(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = await globalThis.crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      arrayBufferFor(textEncoder.encode(data)),
    )
    return new Uint8Array(signature)
  }

  const { createHmac } = await import('node:crypto')
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
