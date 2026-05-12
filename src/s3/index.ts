/**
 * S3-compatible helpers for using B2 with the AWS SDK.
 *
 * Provides {@link createS3ClientConfig} to derive endpoint, region, and
 * credentials from B2 authorization state, plus {@link presignGetObjectUrl}
 * for generating download URLs using B2 native download authorization.
 *
 * @packageDocumentation
 */

import type { AccountInfo } from '../auth/account-info.ts'

/** Configuration for deriving S3-compatible client settings from B2 auth state. */
export interface B2S3Config {
  /** The authorized AccountInfo containing S3 endpoint and credentials. */
  readonly accountInfo: AccountInfo
  /** Override the S3 region. If omitted, extracted from the S3 API URL. */
  readonly region?: string
}

/** Configuration object compatible with `@aws-sdk/client-s3`'s S3Client constructor. */
export interface S3ClientConfig {
  /** The S3-compatible endpoint URL (e.g., `https://s3.us-west-004.backblazeb2.com`). */
  readonly endpoint: string
  /** The S3 region identifier (e.g., `us-west-004`). */
  readonly region: string
  /** AWS-style credentials derived from the B2 account ID and auth token. */
  readonly credentials: {
    /** The B2 account ID, used as the S3 access key ID. */
    readonly accessKeyId: string
    /** The B2 auth token, used as the S3 secret access key. */
    readonly secretAccessKey: string
  }
  /** Always `true` for B2, which requires path-style bucket addressing. */
  readonly forcePathStyle: boolean
}

/**
 * Derives an S3-compatible client configuration from B2 authorization state.
 * Pass the result to `new S3Client(config)` from `@aws-sdk/client-s3`.
 *
 * @param config - B2 auth state and optional region override.
 *
 * @returns Configuration ready for the AWS S3 SDK.
 */
export function createS3ClientConfig(config: B2S3Config): S3ClientConfig {
  const s3Url = config.accountInfo.getS3ApiUrl()
  const regionMatch = s3Url.match(/s3\.([^.]+)\.backblazeb2\.com/)
  const region = config.region ?? regionMatch?.[1] ?? 'us-west-004'

  return {
    endpoint: s3Url,
    region,
    credentials: {
      accessKeyId: config.accountInfo.getAccountId(),
      secretAccessKey: config.accountInfo.getAuthToken(),
    },
    forcePathStyle: true,
  }
}

/**
 * Constructs a presigned download URL using B2's native download authorization.
 * This is not a standard S3 presigned URL but works for B2 download endpoints.
 *
 * @param downloadUrl - The B2 download URL from authorization (e.g., `https://f004.backblazeb2.com`).
 * @param bucketName - The bucket containing the file.
 * @param fileName - The file name (path) to download.
 * @param authorizationToken - A download authorization token from `b2_get_download_authorization`.
 * @param validDurationInSeconds - URL validity duration in seconds. Defaults to 3600 (1 hour).
 *
 * @returns The presigned download URL string.
 */
export function presignGetObjectUrl(
  downloadUrl: string,
  bucketName: string,
  fileName: string,
  authorizationToken: string,
  validDurationInSeconds = 3600,
): string {
  const expires = Math.floor(Date.now() / 1000) + validDurationInSeconds
  return `${downloadUrl}/file/${encodeURIComponent(bucketName)}/${encodeURIComponent(fileName)}?Authorization=${encodeURIComponent(authorizationToken)}&expires=${expires}`
}
