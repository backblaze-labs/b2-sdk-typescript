import { hexEncode, hmacSha256, sha256Hex } from '../util/crypto.ts'
import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { utf8Encoder } from '../util/text-codec.ts'

const FILE_NAME_MAX_BYTES = 1024
const MAX_PRESIGN_EXPIRES_IN = 604_800
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
/** Default S3 presigned URL validity duration in seconds. */
export const DEFAULT_PRESIGN_EXPIRES_IN = 3600

/** Date input accepted by SigV4 presign internals and deterministic tests. */
export type S3PresignDate = Date | number

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
  const endpoint = new URL(options.endpoint)
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

function buildCanonicalUri(endpointPath: string, bucketName: string, fileName: string): string {
  const basePath =
    endpointPath === '' || endpointPath === '/' ? '' : endpointPath.replace(/\/+$/, '')
  return `${basePath}/${awsPercentEncode(bucketName)}/${encodePath(fileName)}`
}

function canonicalHostHeader(endpoint: URL): string {
  if (endpoint.port === '' || (endpoint.protocol === 'https:' && endpoint.port === '443')) {
    return endpoint.hostname
  }
  return `${endpoint.hostname}:${endpoint.port}`
}

function assertHttpsEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== 'https:') {
    throw new TypeError(
      `S3 presigned URLs require an https: endpoint; received "${endpoint.origin}".`,
    )
  }
}

function assertSafeBucketName(bucketName: string): void {
  if (bucketName.length === 0) {
    throw new TypeError('bucketName must be a non-empty string.')
  }
  if (bucketName === '.' || bucketName === '..' || /[/\\]/.test(bucketName)) {
    throw new TypeError('bucketName must not be "." or ".." and must not contain path separators.')
  }
}

function assertValidB2FileName(fileName: string): void {
  if (fileName.length === 0) {
    throw new TypeError('fileName must be a non-empty string.')
  }

  const bytes = utf8Encoder.encode(fileName)
  if (bytes.byteLength > FILE_NAME_MAX_BYTES) {
    throw new TypeError(
      `fileName must be at most ${FILE_NAME_MAX_BYTES} UTF-8 bytes; received ${bytes.byteLength}.`,
    )
  }

  for (let i = 0; i < fileName.length; i++) {
    const code = fileName.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError('fileName must not contain control characters (U+0000-U+001F or U+007F).')
    }
  }

  if (fileName.startsWith('/') || fileName.endsWith('/') || fileName.includes('//')) {
    throw new TypeError('fileName cannot start with "/", end with "/", or contain "//".')
  }

  if (fileName.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(
      'fileName must not contain dot-only path segments because URL parsers can normalize presigned S3 paths.',
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
  return headers
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
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
