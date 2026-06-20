import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccountInfo } from '../auth/account-info.ts'

const SIGNING_DATE = new Date('2024-01-02T03:04:05Z')

function createMockAccountInfo(): AccountInfo {
  return {
    getS3ApiUrl: () => 'https://s3.us-west-004.backblazeb2.com',
    getAccountId: () => 'test-account-id',
    getAuthToken: () => 'test-auth-token',
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

function basePresignOptions() {
  return {
    accountInfo: createMockAccountInfo(),
    applicationKeyId: 'key-id',
    applicationKey: 'key-secret',
    bucketName: 'my-bucket',
    fileName: 'path/to/file.txt',
    expiresIn: 900,
  }
}

describe('S3 presign peer dependency boundary', () => {
  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-s3')
    vi.doUnmock('@aws-sdk/s3-request-presigner')
    vi.resetModules()
    vi.useRealTimers()
  })

  it('does not load AWS peer modules while signing GET and PUT URLs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(SIGNING_DATE)
    vi.resetModules()
    vi.doMock('@aws-sdk/client-s3', () => {
      throw new Error('presign helpers must not import @aws-sdk/client-s3')
    })
    vi.doMock('@aws-sdk/s3-request-presigner', () => {
      throw new Error('presign helpers must not import @aws-sdk/s3-request-presigner')
    })

    const s3 = await import('./index.ts')
    const getUrl = await s3.presignS3GetObjectUrl(basePresignOptions())
    const putUrl = await s3.presignS3PutObjectUrl({
      ...basePresignOptions(),
      fileName: 'path/to/upload.txt',
      contentType: 'text/plain',
    })

    expect(getUrl).not.toContain('key-secret')
    expect(putUrl).not.toContain('key-secret')
  })
})
