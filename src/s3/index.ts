/**
 * S3-compatible helpers for using B2 with the AWS SDK and S3 clients.
 *
 * Provides {@link createS3ClientConfig} to derive endpoint, region, and
 * credentials from B2 authorization state, plus {@link presignS3GetObjectUrl}
 * and {@link presignS3PutObjectUrl} for generating AWS Signature Version 4
 * presigned URLs against B2's S3-compatible API.
 *
 * @packageDocumentation
 */

import type { AccountInfo } from '../auth/account-info.ts'
import { hostMatchesAllowedSuffix } from '../http/url-guard.ts'
import { redactUrlForError } from '../internal/url-redaction.ts'
import { encodeFileName } from '../raw/encoding.ts'
import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import {
  presignS3Request,
  type QueryParam,
  type SignedHeader,
  type SigV4PresignRequestOptions,
} from './sigv4.ts'
import { assertNativeDownloadFileName, assertSafeBucketName } from './validation.ts'

const HTTP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HTTP_MEDIA_TYPE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const DEFAULT_NATIVE_DOWNLOAD_URL_EXPIRES_IN = 3600
const TRUSTED_NATIVE_DOWNLOAD_HOST_SUFFIXES = [
  'backblazeb2.com',
  'backblaze.com',
  'backblaze.net',
  'b2-staging.io',
] as const
const BROWSER_EXECUTABLE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'text/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-ecmascript',
  'text/x-ecmascript',
  'text/xml',
  'application/xml',
])

/**
 * Trusted server-side token for intentionally allowing active-content S3 presign options.
 *
 * Plain objects and JSON payloads cannot satisfy the runtime identity check
 * for this token. Pass this exported value only from trusted application code
 * after applying your own content and response-header policy.
 */
export interface TrustedUnsafeS3PresignOptIn {
  /**
   * Internal marker used only by the runtime identity check.
   *
   * @internal
   */
  readonly __trustedUnsafeS3PresignOptIn: 'trustedUnsafeS3PresignOptIn'
}

const trustedUnsafeS3PresignOptInValue: TrustedUnsafeS3PresignOptIn = Object.freeze({
  __trustedUnsafeS3PresignOptIn: 'trustedUnsafeS3PresignOptIn',
})

/**
 * Server-side opt-in token for unsafe S3 presign options.
 *
 * Use this token as the value for `allowBrowserExecutableContentType`,
 * `allowBrowserExecutableResponseContentType`, or
 * `allowInlineResponseContentDisposition` only when active content or inline
 * rendering from the storage origin is intentional and trusted.
 */
export const trustedUnsafeS3PresignOptIn: TrustedUnsafeS3PresignOptIn =
  trustedUnsafeS3PresignOptInValue

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

/** Common options for S3-compatible presigned object URLs. */
export interface S3PresignObjectUrlOptions extends B2S3Config {
  /** Bucket containing the object. */
  readonly bucketName: string
  /**
   * Object key / B2 file name to sign. Keys with path segments exactly `.`
   * or `..` cannot be presigned safely because common URL parsers normalize
   * them before sending the request.
   */
  readonly fileName: string
  /**
   * URL validity duration in seconds. Defaults to 3600. Must be an integer
   * from 1 to 604800 (7 days), the AWS Signature Version 4 presign maximum.
   * A presigned URL is a bearer credential for the signed operation; keep
   * this as short as the calling workflow allows.
   */
  readonly expiresIn?: number
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
   * attachment disposition when this value can be influenced by users. The
   * helper rejects `inline` response dispositions by default because they can
   * make stored bytes render from the storage origin.
   */
  readonly responseContentDisposition?: string
  /**
   * Permit an `inline` response Content-Disposition override. Set only when
   * the object bytes and response headers are trusted to render from the
   * storage origin. Pass {@link trustedUnsafeS3PresignOptIn}; plain booleans
   * from request JSON are intentionally ignored by the runtime guard.
   */
  readonly allowInlineResponseContentDisposition?: TrustedUnsafeS3PresignOptIn
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
   * can make stored bytes render as active content from the storage origin.
   * Restrict it to known-safe values before signing. The helper's built-in
   * rejection of known browser-executable and sniffable XML/JavaScript media
   * types is best-effort and does not replace an application allow-list.
   */
  readonly responseContentType?: string
  /**
   * Permit browser-executable `responseContentType` overrides such as
   * `text/html`, JavaScript, SVG, or XML media types. Leave this unset unless
   * the served object is intentionally meant to render active content from the
   * storage origin. Pass {@link trustedUnsafeS3PresignOptIn}; plain booleans
   * from request JSON are intentionally ignored by the runtime guard.
   */
  readonly allowBrowserExecutableResponseContentType?: TrustedUnsafeS3PresignOptIn
  /**
   * Override the response Expires header. Do not populate this from
   * untrusted input without an allow-list.
   */
  readonly responseExpires?: Date
}

/** Options for {@link presignS3PutObjectUrl}. */
export interface PresignS3PutObjectUrlOptions extends S3PresignObjectUrlOptions {
  /**
   * Optional content type for the uploaded object. When supplied, the generated
   * URL signs the Content-Type header, so upload clients must send the same
   * value. Browser-executable and sniffable XML/JavaScript types are rejected
   * by default as a best-effort guard; callers accepting untrusted uploads
   * should still enforce their own allow-list.
   */
  readonly contentType?: string
  /**
   * Permit browser-executable `contentType` values such as `text/html`,
   * JavaScript, SVG, or XML media types. Leave this unset unless the uploaded
   * object is intentionally meant to render active content from the storage
   * origin. Pass {@link trustedUnsafeS3PresignOptIn}; plain booleans from
   * request JSON are intentionally ignored by the runtime guard.
   */
  readonly allowBrowserExecutableContentType?: TrustedUnsafeS3PresignOptIn
  /**
   * Optional content length. Must be a non-negative safe integer. When
   * supplied, the generated URL signs the Content-Length header, so upload
   * clients must send the same value.
   */
  readonly contentLength?: number
  /**
   * Optional user metadata to attach to the object. The generated URL signs
   * matching `x-amz-meta-*` headers, so upload clients must send the same values.
   * Pass bare metadata keys; the helper adds the `x-amz-meta-` prefix. Metadata
   * keys must be valid HTTP header tokens and must not differ only by case.
   */
  readonly metadata?: Record<string, string>
}

/**
 * Options for {@link presignPutObjectUrl}.
 *
 * @deprecated Use {@link PresignS3PutObjectUrlOptions}.
 */
export type PresignPutObjectUrlOptions = PresignS3PutObjectUrlOptions

/**
 * Derives an S3-compatible client configuration from B2 authorization state.
 * Pass the result to `new S3Client(config)` from `@aws-sdk/client-s3`.
 *
 * Non-standard, custom, or proxied endpoints require an explicit `region`; set
 * it before deploying this SDK to those endpoints. The SDK no longer falls back
 * to `us-west-004` because that can mis-sign requests.
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
  assertNonEmptyStringOption('applicationKeyId', config.applicationKeyId)
  assertNonEmptyStringOption('applicationKey', config.applicationKey)
  assertNonEmptyStringOption('region', region)
  assertSigV4CredentialScopeComponent('applicationKeyId', config.applicationKeyId)
  assertSigV4CredentialScopeComponent('region', region)

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
 * {@link presignS3PutObjectUrl} when this returns `null`.
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

// S3 SigV4 presign helpers.

/**
 * Generates an AWS Signature Version 4 presigned GET URL for B2's S3-compatible API.
 *
 * This helper signs internally and does not pass the B2 application key to
 * runtime peer dependencies. Response override options are signed into the URL
 * and control headers served from the storage origin; do not populate them from
 * untrusted input without an allow-list. Presign success does not prove the URL
 * will be accepted later; keep URL-generating hosts clock-synchronized and
 * check clock skew when downstream use returns SigV4 403 errors.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignS3GetObjectUrl(
  options: PresignS3GetObjectUrlOptions,
): Promise<string> {
  const query: QueryParam[] = [['x-id', 'GetObject']]
  if (options.versionId !== undefined) {
    assertSafeQueryValue('versionId', options.versionId)
    query.push(['versionId', options.versionId])
  }
  if (options.responseCacheControl !== undefined) {
    assertSafeResponseOverride('responseCacheControl', options.responseCacheControl)
    query.push(['response-cache-control', options.responseCacheControl])
  }
  if (options.responseContentDisposition !== undefined) {
    assertSafeResponseContentDisposition(
      options.responseContentDisposition,
      isTrustedUnsafeS3PresignOptIn(options.allowInlineResponseContentDisposition),
    )
    query.push(['response-content-disposition', options.responseContentDisposition])
  }
  if (options.responseContentEncoding !== undefined) {
    assertSafeResponseOverride('responseContentEncoding', options.responseContentEncoding)
    query.push(['response-content-encoding', options.responseContentEncoding])
  }
  if (options.responseContentLanguage !== undefined) {
    assertSafeResponseOverride('responseContentLanguage', options.responseContentLanguage)
    query.push(['response-content-language', options.responseContentLanguage])
  }
  if (options.responseContentType !== undefined) {
    if (isTrustedUnsafeS3PresignOptIn(options.allowBrowserExecutableResponseContentType)) {
      assertSafeContentTypeValue(
        'responseContentType',
        options.responseContentType,
        'response header value',
      )
    } else {
      assertSafeResponseContentType(options.responseContentType)
    }
    query.push(['response-content-type', options.responseContentType])
  }
  if (options.responseExpires !== undefined) {
    query.push(['response-expires', normalizeResponseExpires(options.responseExpires)])
  }

  return await presignS3Request('GET', createSigV4PresignOptions(options), query, [])
}

/**
 * Returns a B2-native download-authorization URL, not an S3 presigned URL.
 *
 * This deprecated helper preserves the legacy positional output contract where
 * the whole file name is encoded as one URL component, including `/` as `%2F`.
 * It keeps the legacy string-building contract for callers that relied on
 * custom/local download URLs or permissive inputs. Use
 * {@link createNativeDownloadAuthorizationUrl} for strict validation.
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
  const expires =
    Math.floor(Date.now() / 1000) +
    (validDurationInSeconds ?? DEFAULT_NATIVE_DOWNLOAD_URL_EXPIRES_IN)
  return `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeURIComponent(fileName)}?Authorization=${encodeURIComponent(authorizationToken)}&expires=${expires}`
}

/**
 * Generates an AWS Signature Version 4 presigned PUT URL for browser or
 * third-party uploads through B2's S3-compatible API.
 *
 * This helper signs internally and does not pass the B2 application key to
 * runtime peer dependencies. A presigned PUT URL is a replayable bearer
 * credential for writing one key until expiry. Retried PUTs can create
 * duplicate B2 file versions when a response is lost after B2 stored the object.
 * Use unique keys or reconcile uploaded file IDs/checksums, and configure
 * lifecycle/version cleanup where duplicate versions must be removed
 * automatically. If `contentType` and `contentLength` are omitted, the holder
 * can choose any content type, including browser-executable types, and any size
 * accepted by B2; bind both values before handing URLs to untrusted uploaders
 * to limit financial-DoS and content-type smuggling risk.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignS3PutObjectUrl(
  options: PresignS3PutObjectUrlOptions,
): Promise<string> {
  const headers: SignedHeader[] = []
  if (options.contentType !== undefined) {
    if (isTrustedUnsafeS3PresignOptIn(options.allowBrowserExecutableContentType)) {
      assertSafeContentTypeValue('contentType', options.contentType, 'stored object Content-Type')
    } else {
      assertSafePutContentType(options.contentType)
    }
    headers.push(['content-type', options.contentType])
  }
  if (options.contentLength !== undefined) {
    headers.push(['content-length', normalizeContentLength(options.contentLength)])
  }
  headers.push(...normalizeMetadataHeaders(options.metadata))

  return await presignS3Request(
    'PUT',
    createSigV4PresignOptions(options),
    [['x-id', 'PutObject']],
    headers,
  )
}

/**
 * Generates an AWS Signature Version 4 presigned PUT URL for B2's
 * S3-compatible API.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 *
 * @deprecated Use {@link presignS3PutObjectUrl}; this alias is retained for
 * pre-release callers that adopted the shorter name.
 */
export async function presignPutObjectUrl(options: PresignPutObjectUrlOptions): Promise<string> {
  return await presignS3PutObjectUrl(options)
}

// B2-native download authorization helper.

/**
 * Constructs a B2-native download URL using a token from `b2_get_download_authorization`.
 * This is not an S3 presigned URL.
 *
 * The token lifetime is fixed when `b2_get_download_authorization` creates the
 * token. `validDurationInSeconds` is retained only for compatibility with the
 * legacy `presignGetObjectUrl` helper's decorative `expires` query parameter;
 * changing it here does not shorten or extend access.
 * Because the returned URL carries a bearer token, `downloadUrl` must be an
 * HTTPS Backblaze download origin without userinfo, path, query, or fragment.
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
  validDurationInSeconds = DEFAULT_NATIVE_DOWNLOAD_URL_EXPIRES_IN,
): string {
  return buildNativeDownloadAuthorizationUrl(
    downloadUrl,
    bucketName,
    fileName,
    authorizationToken,
    validDurationInSeconds,
    encodeFileName,
    assertNativeDownloadFileName,
  )
}

function deriveRequiredS3Region(endpoint: string): string {
  const region = deriveS3RegionFromEndpoint(endpoint)
  if (region !== null) return region

  throw new Error(
    `Unable to derive B2 S3 region from endpoint "${redactUrlForError(endpoint, {
      invalidUrlLabel: '<invalid S3 endpoint URL>',
    })}". Pass an explicit \`region\` option before deploying custom or proxied endpoints.`,
  )
}

function createSigV4PresignOptions(options: S3PresignObjectUrlOptions): SigV4PresignRequestOptions {
  const clientConfig = createS3ClientConfig(options)
  return {
    endpoint: clientConfig.endpoint,
    region: clientConfig.region,
    accessKeyId: clientConfig.credentials.accessKeyId,
    secretAccessKey: clientConfig.credentials.secretAccessKey,
    bucketName: options.bucketName,
    fileName: options.fileName,
    ...(options.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {}),
  }
}

function normalizeContentLength(contentLength: number): string {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new RangeError(
      `contentLength must be a non-negative safe integer; received ${String(contentLength)}.`,
    )
  }

  return String(contentLength)
}

function normalizeValidDurationInSeconds(validDurationInSeconds: number): number {
  if (!Number.isSafeInteger(validDurationInSeconds) || validDurationInSeconds < 0) {
    throw new RangeError(
      `validDurationInSeconds must be a non-negative safe integer; received ${String(
        validDurationInSeconds,
      )}.`,
    )
  }

  return validDurationInSeconds
}

function assertNonEmptyStringOption(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`)
  }
}

function assertSigV4CredentialScopeComponent(name: string, value: string): void {
  if (/[\s/]/u.test(value) || hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(
      `${name} must not contain whitespace, control characters, or "/" because it is embedded in the SigV4 credential scope.`,
    )
  }
}

function isTrustedUnsafeS3PresignOptIn(value: unknown): value is TrustedUnsafeS3PresignOptIn {
  return value === trustedUnsafeS3PresignOptIn
}

function buildNativeDownloadAuthorizationUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
  validDurationInSeconds: number,
  encodeFileNameForUrl: (fileName: string) => string,
  assertFileName: (fileName: string) => void,
): string {
  const baseUrl = parseNativeDownloadBaseUrl(downloadUrl)
  assertSafeBucketName(bucketName)
  assertFileName(fileName)
  const expires =
    Math.floor(Date.now() / 1000) + normalizeValidDurationInSeconds(validDurationInSeconds)
  return `${baseUrl}/file/${encodeURIComponent(bucketName)}/${encodeFileNameForUrl(fileName)}?Authorization=${encodeURIComponent(authorizationToken)}&expires=${expires}`
}

function parseNativeDownloadBaseUrl(downloadUrl: string): string {
  let base: URL
  try {
    base = new URL(downloadUrl)
  } catch {
    throw new TypeError(
      `Native download-authorization URLs require a valid https: downloadUrl; received "${redactUrlForError(
        downloadUrl,
        { invalidUrlLabel: '<invalid downloadUrl>' },
      )}".`,
    )
  }

  if (base.protocol !== 'https:') {
    throw new TypeError(
      `Native download-authorization URLs require an https: downloadUrl; received "${redactUrlForError(
        base,
      )}".`,
    )
  }
  if (base.username !== '' || base.password !== '') {
    throw new TypeError('Native download-authorization URLs must not include userinfo.')
  }
  if (base.search !== '' || base.hash !== '') {
    throw new TypeError('Native download-authorization URLs must not include query or fragment.')
  }
  if (base.pathname !== '' && base.pathname !== '/') {
    throw new TypeError('Native download-authorization URLs must not include a path.')
  }
  if (!isTrustedNativeDownloadHost(base.hostname)) {
    throw new TypeError(
      `Native download-authorization URLs require a Backblaze download host; received "${redactUrlForError(
        base,
      )}".`,
    )
  }

  return base.origin
}

function normalizeMetadataHeaders(metadata: Record<string, string> | undefined): SignedHeader[] {
  const headers: SignedHeader[] = []
  const seenKeys = new Set<string>()

  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!HTTP_HEADER_TOKEN.test(key)) {
      throw new TypeError(`metadata key "${key}" must be a non-empty valid HTTP header token.`)
    }
    if (typeof value !== 'string') {
      throw new TypeError(`metadata value for "${key}" must be a string.`)
    }

    const lowerKey = key.toLowerCase()
    if (seenKeys.has(lowerKey)) {
      throw new TypeError(`metadata key "${key}" must not differ only by case.`)
    }

    seenKeys.add(lowerKey)
    headers.push([`x-amz-meta-${lowerKey}`, value])
  }

  return headers
}

function normalizeResponseExpires(responseExpires: Date): string {
  if (!Number.isFinite(responseExpires.getTime())) {
    throw new RangeError('responseExpires must be a valid Date.')
  }

  return responseExpires.toUTCString()
}

function assertSafeResponseOverride(name: string, value: string): void {
  assertSafeHeaderValue(name, value, 'response header value')
}

function assertSafeQueryValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(
      `${name} must not contain control characters because it becomes a query parameter.`,
    )
  }
}

function assertSafeHeaderValue(name: string, value: string, target: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(
      `${name} must not contain control characters because it becomes a ${target}.`,
    )
  }
}

function assertSafeResponseContentType(contentType: string): void {
  assertNonExecutableContentType(
    'responseContentType',
    contentType,
    'response header value',
    'allow-list a safe content type before signing response overrides',
  )
}

function assertSafePutContentType(contentType: string): void {
  assertNonExecutableContentType(
    'contentType',
    contentType,
    'stored object Content-Type',
    'pass allowBrowserExecutableContentType only when active content is intentional',
  )
}

function assertSafeResponseContentDisposition(
  contentDisposition: string,
  allowInline: boolean,
): void {
  assertSafeResponseOverride('responseContentDisposition', contentDisposition)

  const disposition = contentDisposition.split(';', 1)[0]?.trim().toLowerCase()
  if (!allowInline && disposition === 'inline') {
    throw new TypeError(
      'responseContentDisposition must not force inline rendering; use an attachment disposition for response overrides.',
    )
  }
}

function mediaTypeFor(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function assertSafeContentTypeValue(name: string, contentType: string, target: string): string {
  assertSafeHeaderValue(name, contentType, target)

  const mediaType = mediaTypeFor(contentType)
  if (mediaType.length === 0) {
    throw new TypeError(`${name} must include a non-empty media type.`)
  }
  if (!HTTP_MEDIA_TYPE.test(mediaType)) {
    throw new TypeError(`${name} must include a valid media type.`)
  }

  return mediaType
}

function assertNonExecutableContentType(
  name: string,
  contentType: string,
  target: string,
  guidance: string,
): void {
  const mediaType = assertSafeContentTypeValue(name, contentType, target)
  if (isBrowserExecutableContentType(mediaType)) {
    throw new TypeError(`${name} "${mediaType}" can execute in browsers; ${guidance}.`)
  }
}

function isBrowserExecutableContentType(mediaType: string): boolean {
  return BROWSER_EXECUTABLE_CONTENT_TYPES.has(mediaType) || mediaType.endsWith('+xml')
}

function isTrustedNativeDownloadHost(hostname: string): boolean {
  return TRUSTED_NATIVE_DOWNLOAD_HOST_SUFFIXES.some((suffix) =>
    hostMatchesAllowedSuffix(hostname, suffix),
  )
}
