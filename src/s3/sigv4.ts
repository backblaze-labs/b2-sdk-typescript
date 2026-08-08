import { redactUrlForError } from '../internal/url-redaction.ts'
import { hexEncode, hmacSha256, sha256Hex } from '../util/crypto.ts'
import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { assertSafeBucketName, assertValidB2FileName } from './validation.ts'

const MAX_PRESIGN_EXPIRES_IN = 604_800
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
/** Default S3 presigned URL validity duration in seconds. */
export const DEFAULT_PRESIGN_EXPIRES_IN = 3600

/** Date input accepted by SigV4 presign internals and deterministic tests. */
export type S3PresignDate = Date | number

/** HTTP method accepted by SigV4 signed S3-compatible requests. */
export type S3SignedRequestMethod = 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT'

/** Query parameter included in the SigV4 canonical query string. */
export type QueryParam = readonly [name: string, value: string]

/** HTTP header included in the SigV4 signed headers list. */
export type SignedHeader = readonly [name: string, value: string]

/** Internal inputs required to presign one S3-compatible object request. */
export interface SigV4PresignRequestOptions {
  /** S3-compatible endpoint URL. */
  readonly endpoint: string
  /** S3 signing region. */
  readonly region: string
  /** S3 access key ID. */
  readonly accessKeyId: string
  /** S3 secret access key. */
  readonly secretAccessKey: string
  /** Bucket containing the object. */
  readonly bucketName: string
  /** Object key / B2 file name. */
  readonly fileName: string
  /** Optional URL validity duration in seconds. */
  readonly expiresIn?: number
  /** Optional signing clock override. */
  readonly signingDate?: S3PresignDate
}

/** Internal inputs required to sign one S3-compatible HTTP request. */
export interface SigV4SignedRequestOptions {
  /** S3-compatible endpoint URL. */
  readonly endpoint: string
  /** S3 signing region. */
  readonly region: string
  /** S3 access key ID. */
  readonly accessKeyId: string
  /** S3 secret access key. */
  readonly secretAccessKey: string
  /** Bucket targeted by the request. */
  readonly bucketName: string
  /** Optional object key / B2 file name targeted by the request. */
  readonly fileName?: string
  /** Operation-specific query parameters to sign. */
  readonly query?: readonly QueryParam[]
  /** Operation-specific headers to sign and send. */
  readonly headers?: readonly SignedHeader[]
  /** Payload hash placed in `x-amz-content-sha256`. */
  readonly payloadHash: string
  /** Optional signing clock override. */
  readonly signingDate?: S3PresignDate
}

/** Signed URL and headers ready for `fetch`. */
export interface SigV4SignedRequest {
  /** Fully qualified request URL. */
  readonly url: string
  /** Headers containing SigV4 authentication. */
  readonly headers: Headers
}

/**
 * Generates an AWS Signature Version 4 presigned S3-compatible request URL.
 *
 * This module owns only canonical SigV4 mechanics: canonical URI/query/header
 * construction, signing-key derivation, and signature encoding. Public B2 S3
 * option validation and naming stay in `index.ts`.
 *
 * @param method - HTTP method to presign.
 * @param options - S3 endpoint, credentials, object key, and signing options.
 * @param extraQuery - Operation-specific query parameters to sign.
 * @param extraHeaders - Operation-specific request headers to sign.
 *
 * @returns The presigned request URL.
 */
export async function presignS3Request(
  method: 'GET' | 'PUT',
  options: SigV4PresignRequestOptions,
  extraQuery: readonly QueryParam[],
  extraHeaders: readonly SignedHeader[],
): Promise<string> {
  const endpoint = parseEndpoint(options.endpoint)
  assertHttpsEndpoint(endpoint)
  const expiresIn = normalizeExpiresIn(options.expiresIn)
  const { shortDate, longDate } = formatSigningDate(options.signingDate)
  const credentialScope = `${shortDate}/${options.region}/${SERVICE}/${TERMINATOR}`
  const credential = `${options.accessKeyId}/${credentialScope}`
  assertSafeBucketName(options.bucketName)
  assertValidB2FileName(options.fileName)
  const canonicalUri = buildCanonicalUri(endpoint.pathname, options.bucketName, options.fileName)
  const headers = normalizeSignedHeaders([['host', canonicalHostHeader(endpoint)], ...extraHeaders])
  const signedHeaders = headers.map(([name]) => name).join(';')

  const query: QueryParam[] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Content-Sha256', UNSIGNED_PAYLOAD],
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
  const signingKey = await deriveSigningKey(options.secretAccessKey, shortDate, options.region)
  const signature = hexEncode(await hmacSha256(signingKey, stringToSign))
  const finalQuery = canonicalQueryString([...query, ['X-Amz-Signature', signature]])

  return `${endpoint.origin}${canonicalUri}?${finalQuery}`
}

/**
 * Signs an S3-compatible HTTP request with AWS Signature Version 4 headers.
 *
 * This shares canonical URI, query, header, date, and signing-key mechanics
 * with {@link presignS3Request}; callers provide only operation-specific
 * request data and the payload hash.
 *
 * @param method - HTTP method to sign.
 * @param options - S3 endpoint, credentials, target, query, headers, and payload hash.
 *
 * @returns The signed request URL and headers.
 */
export async function signS3Request(
  method: S3SignedRequestMethod,
  options: SigV4SignedRequestOptions,
): Promise<SigV4SignedRequest> {
  const endpoint = parseEndpoint(options.endpoint)
  assertHttpsEndpoint(endpoint)
  assertSafeBucketName(options.bucketName)
  if (options.fileName !== undefined) assertValidB2FileName(options.fileName)

  const { shortDate, longDate } = formatSigningDate(options.signingDate)
  const canonicalUri = buildCanonicalUri(endpoint.pathname, options.bucketName, options.fileName)
  const canonicalQuery = canonicalQueryString(options.query ?? [])
  const url = `${endpoint.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`
  const headers = new Headers()
  for (const [name, value] of options.headers ?? []) {
    headers.set(name, value)
  }
  headers.set('x-amz-content-sha256', options.payloadHash)
  headers.set('x-amz-date', longDate)
  const signedHeaders = normalizeSignedHeaders([
    ['host', canonicalHostHeader(endpoint)],
    ...[...headers.entries()],
  ])
  const signedHeaderNames = signedHeaders.map(([name]) => name).join(';')
  const canonicalHeaders = signedHeaders.map(([name, value]) => `${name}:${value}\n`).join('')
  const credentialScope = `${shortDate}/${options.region}/${SERVICE}/${TERMINATOR}`
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    options.payloadHash,
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    longDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const signingKey = await deriveSigningKey(options.secretAccessKey, shortDate, options.region)
  const signature = hexEncode(await hmacSha256(signingKey, stringToSign))
  headers.set(
    'authorization',
    [
      'AWS4-HMAC-SHA256',
      `Credential=${options.accessKeyId}/${credentialScope},`,
      `SignedHeaders=${signedHeaderNames},`,
      `Signature=${signature}`,
    ].join(' '),
  )

  return { url, headers }
}

function normalizeExpiresIn(expiresIn: number | undefined): number {
  const value = expiresIn ?? DEFAULT_PRESIGN_EXPIRES_IN
  if (!Number.isInteger(value) || value < 1 || value > MAX_PRESIGN_EXPIRES_IN) {
    throw new RangeError(
      `expiresIn must be an integer from 1 to ${MAX_PRESIGN_EXPIRES_IN} seconds; received ${String(value)}.`,
    )
  }
  return value
}

function formatSigningDate(input: S3PresignDate | undefined): {
  readonly shortDate: string
  readonly longDate: string
} {
  const date = input === undefined ? new Date() : new Date(input)
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('signingDate must be a valid Date or timestamp.')
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

function buildCanonicalUri(
  endpointPath: string,
  bucketName: string,
  fileName: string | undefined,
): string {
  const basePath =
    endpointPath === '' || endpointPath === '/' ? '' : endpointPath.replace(/\/+$/, '')
  if (fileName === undefined) return `${basePath}/${awsPercentEncode(bucketName)}`
  return `${basePath}/${awsPercentEncode(bucketName)}/${encodePath(fileName)}`
}

function canonicalHostHeader(endpoint: URL): string {
  const host = endpoint.host
  if (endpoint.protocol === 'https:' && host.endsWith(':443')) {
    return host.slice(0, -4)
  }
  return host
}

function parseEndpoint(endpoint: string): URL {
  try {
    return new URL(endpoint)
  } catch (cause) {
    throw new TypeError(
      `S3 presigned URL endpoint must be a valid URL; received "${redactUrlForError(endpoint, {
        invalidUrlLabel: '<invalid S3 endpoint URL>',
      })}".`,
      { cause },
    )
  }
}

function assertHttpsEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== 'https:') {
    throw new TypeError(
      `S3 presigned URLs require an https: endpoint; received "${redactUrlForError(endpoint)}".`,
    )
  }
}

function encodePath(path: string): string {
  return path.split('/').map(awsPercentEncode).join('/')
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

/**
 * Percent-encode according to AWS SigV4 canonical request rules.
 *
 * @param value - Raw value to encode.
 *
 * @returns AWS-compatible percent-encoded value.
 */
function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function normalizeSignedHeaders(headers: readonly SignedHeader[]): SignedHeader[] {
  const combinedHeaders = new Map<string, string[]>()
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase()
    const values = combinedHeaders.get(normalizedName)
    if (values) {
      values.push(normalizeHeaderValue(value))
    } else {
      combinedHeaders.set(normalizedName, [normalizeHeaderValue(value)])
    }
  }

  return [...combinedHeaders.entries()]
    .map(([name, values]) => [name, values.join(',')] as const)
    .sort(([a], [b]) => {
      if (a < b) return -1
      if (a > b) return 1
      return 0
    })
}

function normalizeHeaderValue(value: string): string {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError('signed header values must not contain control characters.')
  }

  return value.trim().replace(/ +/g, ' ')
}

async function deriveSigningKey(
  secretAccessKey: string,
  shortDate: string,
  region: string,
): Promise<Uint8Array> {
  const dateKey = await hmacSha256(`AWS4${secretAccessKey}`, shortDate)
  const dateRegionKey = await hmacSha256(dateKey, region)
  const dateRegionServiceKey = await hmacSha256(dateRegionKey, SERVICE)
  return await hmacSha256(dateRegionServiceKey, TERMINATOR)
}
