import type { AccountInfo } from '../auth/account-info.js'

export interface B2S3Config {
  readonly accountInfo: AccountInfo
  readonly region?: string
}

export interface S3ClientConfig {
  readonly endpoint: string
  readonly region: string
  readonly credentials: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
  }
  readonly forcePathStyle: boolean
}

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
