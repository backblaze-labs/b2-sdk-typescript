/**
 * S3-compatible helpers for using B2 with the AWS SDK.
 *
 * Provides {@link createS3ClientConfig} to derive endpoint, region, and
 * credentials from B2 authorization state, plus {@link presignGetObjectUrl}
 * and {@link presignPutObjectUrl} for generating AWS Signature Version 4
 * presigned URLs against B2's S3-compatible API.
 *
 * @packageDocumentation
 */

import type { S3ClientConfig as AwsS3ClientConfig } from '@aws-sdk/client-s3'
import type { AccountInfo } from '../auth/account-info.ts'

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

/** Date input accepted by the AWS request presigner. */
export type S3PresignDate = Date | number | string

/** Common options for S3-compatible presigned object URLs. */
export interface S3PresignObjectUrlOptions extends B2S3Config {
  /** Bucket containing the object. */
  readonly bucketName: string
  /** Object key / B2 file name to sign. */
  readonly fileName: string
  /** URL validity duration in seconds. Defaults to 3600 (1 hour). */
  readonly expiresIn?: number
  /** Optional signing clock override, primarily useful for deterministic tests. */
  readonly signingDate?: S3PresignDate
}

/** Options for {@link presignGetObjectUrl}. */
export interface PresignGetObjectUrlOptions extends S3PresignObjectUrlOptions {
  /** Optional S3 version ID to include in the signed GET request. */
  readonly versionId?: string
  /** Override the response Cache-Control header. */
  readonly responseCacheControl?: string
  /** Override the response Content-Disposition header. */
  readonly responseContentDisposition?: string
  /** Override the response Content-Encoding header. */
  readonly responseContentEncoding?: string
  /** Override the response Content-Language header. */
  readonly responseContentLanguage?: string
  /** Override the response Content-Type header. */
  readonly responseContentType?: string
  /** Override the response Expires header. */
  readonly responseExpires?: Date
}

/** Options for {@link presignPutObjectUrl}. */
export interface PresignPutObjectUrlOptions extends S3PresignObjectUrlOptions {
  /** Optional content type for the uploaded object. */
  readonly contentType?: string
  /**
   * Optional content length. When supplied, the generated URL signs the
   * Content-Length header, so upload clients must send the same value.
   */
  readonly contentLength?: number
  /** Optional user metadata to attach to the object. */
  readonly metadata?: Record<string, string>
}

/**
 * Derives an S3-compatible client configuration from B2 authorization state.
 * Pass the result to `new S3Client(config)` from `@aws-sdk/client-s3`.
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
 * {@link createS3ClientConfig}, {@link presignGetObjectUrl}, or
 * {@link presignPutObjectUrl} when this returns `null`.
 *
 * @param endpoint - The S3 endpoint URL.
 *
 * @returns The derived region, or `null` when the endpoint is not a standard B2 S3 URL.
 */
export function deriveS3RegionFromEndpoint(endpoint: string): string | null {
  const hostname = new URL(endpoint).hostname.toLowerCase()
  const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(hostname)
  return match?.[1] ?? null
}

/**
 * Generates an AWS Signature Version 4 presigned GET URL for B2's S3-compatible API.
 *
 * Requires `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignGetObjectUrl(options: PresignGetObjectUrlOptions): Promise<string> {
  const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ])

  const client = await createPresignClient(options)
  return await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: options.bucketName,
      Key: options.fileName,
      ...(options.versionId !== undefined ? { VersionId: options.versionId } : {}),
      ...(options.responseCacheControl !== undefined
        ? { ResponseCacheControl: options.responseCacheControl }
        : {}),
      ...(options.responseContentDisposition !== undefined
        ? { ResponseContentDisposition: options.responseContentDisposition }
        : {}),
      ...(options.responseContentEncoding !== undefined
        ? { ResponseContentEncoding: options.responseContentEncoding }
        : {}),
      ...(options.responseContentLanguage !== undefined
        ? { ResponseContentLanguage: options.responseContentLanguage }
        : {}),
      ...(options.responseContentType !== undefined
        ? { ResponseContentType: options.responseContentType }
        : {}),
      ...(options.responseExpires !== undefined
        ? { ResponseExpires: options.responseExpires }
        : {}),
    }),
    createPresignArguments(options),
  )
}

/**
 * Generates an AWS Signature Version 4 presigned PUT URL for browser or third-party uploads
 * through B2's S3-compatible API.
 *
 * Requires `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
 *
 * @param options - B2 auth state, S3 credentials, target object, and signing options.
 *
 * @returns The presigned URL string.
 */
export async function presignPutObjectUrl(options: PresignPutObjectUrlOptions): Promise<string> {
  const [{ PutObjectCommand }, { getSignedUrl }] = await Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/s3-request-presigner'),
  ])

  const client = await createPresignClient(options)
  return await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: options.bucketName,
      Key: options.fileName,
      ...(options.contentType !== undefined ? { ContentType: options.contentType } : {}),
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
      ...(options.metadata !== undefined ? { Metadata: options.metadata } : {}),
    }),
    createPresignArguments(options),
  )
}

/**
 * Constructs a B2-native download URL using a token from `b2_get_download_authorization`.
 * This is not an S3 presigned URL.
 *
 * @param downloadUrl - The B2 download URL from authorization (e.g., `https://f004.backblazeb2.com`).
 * @param bucketName - The bucket containing the file.
 * @param fileName - The file name (path) to download.
 * @param authorizationToken - A download authorization token from `b2_get_download_authorization`.
 * @param validDurationInSeconds - URL validity duration in seconds. Defaults to 3600 (1 hour).
 *
 * @returns The presigned download URL string.
 */
export function createNativeDownloadAuthorizationUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
  validDurationInSeconds = 3600,
): string {
  const expires = Math.floor(Date.now() / 1000) + validDurationInSeconds
  return `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeURIComponent(fileName)}?Authorization=${encodeURIComponent(authorizationToken)}&expires=${expires}`
}

function deriveRequiredS3Region(endpoint: string): string {
  const region = deriveS3RegionFromEndpoint(endpoint)
  if (region !== null) return region

  throw new Error(
    `Unable to derive B2 S3 region from endpoint "${endpoint}". Pass an explicit region.`,
  )
}

async function createPresignClient(
  options: B2S3Config,
): Promise<import('@aws-sdk/client-s3').S3Client> {
  const { S3Client } = await import('@aws-sdk/client-s3')
  const clientConfig = createS3ClientConfig(options)
  const awsConfig: AwsS3ClientConfig = {
    ...clientConfig,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }
  return new S3Client(awsConfig)
}

function createPresignArguments(options: S3PresignObjectUrlOptions): {
  readonly expiresIn: number
  readonly signingDate?: S3PresignDate
} {
  return {
    expiresIn: options.expiresIn ?? 3600,
    ...(options.signingDate !== undefined ? { signingDate: options.signingDate } : {}),
  }
}
