import { describe, expect, it, vi } from 'vitest'

import type { AccountInfo } from '../auth/account-info.ts'
import { createS3ClientConfig, presignGetObjectUrl } from './index.ts'

/** Minimal mock of AccountInfo with only the methods used by S3 helpers. */
function createMockAccountInfo(
  overrides: { s3ApiUrl?: string; accountId?: string; authToken?: string } = {},
): AccountInfo {
  const {
    s3ApiUrl = 'https://s3.us-west-004.backblazeb2.com',
    accountId = 'test-account-id',
    authToken = 'test-auth-token',
  } = overrides

  return {
    getS3ApiUrl: () => s3ApiUrl,
    getAccountId: () => accountId,
    getAuthToken: () => authToken,
    // Unused stubs required by the AccountInfo interface.
    setAuth: () => {},
    getAuth: () => null,
    clear: () => {},
    getApiUrl: () => '',
    getDownloadUrl: () => '',
    getRecommendedPartSize: () => 0,
    getAbsoluteMinimumPartSize: () => 0,
    getAllowedBucketId: () => null,
    checkoutUploadUrl: () => null,
    returnUploadUrl: () => {},
    evictUploadUrl: () => {},
    checkoutPartUploadUrl: () => null,
    returnPartUploadUrl: () => {},
    evictPartUploadUrl: () => {},
  }
}

describe('createS3ClientConfig', () => {
  it('extracts region from the S3 API URL', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })

    expect(config.region).toBe('us-west-004')
  })

  it('uses provided region override', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://s3.eu-central-003.backblazeb2.com',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      region: 'custom-region',
    })

    expect(config.region).toBe('custom-region')
  })

  it('falls back to us-west-004 when URL does not match the expected pattern', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://some-other-endpoint.example.com',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })

    expect(config.region).toBe('us-west-004')
  })

  it('sets forcePathStyle to true', () => {
    const accountInfo = createMockAccountInfo()

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })

    expect(config.forcePathStyle).toBe(true)
  })

  it('uses applicationKeyId as accessKeyId and applicationKey as secretAccessKey', () => {
    // Regression: previous implementation passed accountId + auth token
    // here, which produced credentials that B2's S3-compatible API
    // rejects. Per https://www.backblaze.com/apidocs/s3-compatible-api,
    // the access key ID maps to the application key ID and the secret
    // access key maps to the application key (secret), NOT the native
    // accountId or authorization token.
    const accountInfo = createMockAccountInfo({
      accountId: 'should-not-leak-into-credentials',
      authToken: 'should-not-leak-into-credentials',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'my-app-key-id',
      applicationKey: 'my-app-key-secret',
    })

    expect(config.credentials.accessKeyId).toBe('my-app-key-id')
    expect(config.credentials.secretAccessKey).toBe('my-app-key-secret')
  })

  it('sets endpoint to the S3 API URL', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })

    expect(config.endpoint).toBe('https://s3.us-west-004.backblazeb2.com')
  })
})

describe('presignGetObjectUrl', () => {
  // Freeze Date.now so expires timestamps are deterministic.
  const FIXED_NOW_MS = 1_700_000_000_000
  const FIXED_NOW_S = Math.floor(FIXED_NOW_MS / 1000)

  it('constructs URL with encoded bucket and file name', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    const url = presignGetObjectUrl(
      'https://f004.backblazeb2.com',
      'my-bucket',
      'path/to/file.txt',
      'auth-token-123',
    )

    expect(url).toContain('/file/my-bucket/path%2Fto%2Ffile.txt')

    vi.restoreAllMocks()
  })

  it('includes the authorization token', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    const url = presignGetObjectUrl(
      'https://f004.backblazeb2.com',
      'bucket',
      'file.txt',
      'secret-token',
    )

    expect(url).toContain('Authorization=secret-token')

    vi.restoreAllMocks()
  })

  it('includes an expires timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    const url = presignGetObjectUrl('https://f004.backblazeb2.com', 'bucket', 'file.txt', 'token')

    const expectedExpires = FIXED_NOW_S + 3600
    expect(url).toContain(`expires=${expectedExpires}`)

    vi.restoreAllMocks()
  })

  it('defaults to 3600 seconds', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    const url = presignGetObjectUrl('https://f004.backblazeb2.com', 'bucket', 'file.txt', 'token')

    const expectedExpires = FIXED_NOW_S + 3600
    expect(url).toContain(`expires=${expectedExpires}`)

    vi.restoreAllMocks()
  })

  it('handles custom duration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS)

    const url = presignGetObjectUrl(
      'https://f004.backblazeb2.com',
      'bucket',
      'file.txt',
      'token',
      7200,
    )

    const expectedExpires = FIXED_NOW_S + 7200
    expect(url).toContain(`expires=${expectedExpires}`)

    vi.restoreAllMocks()
  })
})
