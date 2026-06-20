import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AccountInfo } from '../auth/account-info.ts'
import {
  createNativeDownloadAuthorizationUrl,
  createS3ClientConfig,
  deriveS3RegionFromEndpoint,
  presignGetObjectUrl,
  presignPutObjectUrl,
  presignS3GetObjectUrl,
  presignS3PutObjectUrl,
} from './index.ts'

const SIGNING_DATE = new Date('2024-01-02T03:04:05Z')

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

function useSigningDate(): void {
  vi.useFakeTimers()
  vi.setSystemTime(SIGNING_DATE)
}

afterEach(() => {
  vi.useRealTimers()
})

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

  it('extracts region from URL hostnames with ports and paths', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://s3.eu-central-003.backblazeb2.com:443/custom/path',
    })

    const config = createS3ClientConfig({
      accountInfo,
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })

    expect(config.region).toBe('eu-central-003')
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

  it('requires a region override for non-standard endpoints', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://some-other-endpoint.example.com',
    })

    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
      }),
    ).toThrow('Pass an explicit region')
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

describe('presignS3GetObjectUrl', () => {
  it('generates a SigV4 GET URL for B2 S3 endpoints', async () => {
    useSigningDate()

    const url = new URL(await presignS3GetObjectUrl(basePresignOptions()))

    expect(url.origin).toBe('https://s3.us-west-004.backblazeb2.com')
    expect(url.pathname).toBe('/my-bucket/path/to/file.txt')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.has('X-Amz-Content-Sha256')).toBe(false)
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'key-id/20240102/us-west-004/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20240102T030405Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('x-id')).toBe('GetObject')
    expect(url.searchParams.has('Authorization')).toBe(false)
    expect(url.toString()).not.toContain('key-secret')

    const signature = url.searchParams.get('X-Amz-Signature')
    expect(signature).toBe('1661a8f3dce3f4c3acc5ab65779c2c414879bcf33b103afb63c77364f92d04de')

    const urlWithDifferentSecret = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        applicationKey: 'other-key-secret',
      }),
    )
    expect(urlWithDifferentSecret.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
    expect(urlWithDifferentSecret.searchParams.get('X-Amz-Signature')).not.toBe(signature)
  })

  it('uses explicit regions for custom endpoints', async () => {
    useSigningDate()

    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        accountInfo: createMockAccountInfo({
          s3ApiUrl: 'https://s3.example.test',
        }),
        fileName: 'file.txt',
        region: 'custom-region-1',
      }),
    )

    expect(url.origin).toBe('https://s3.example.test')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'key-id/20240102/custom-region-1/s3/aws4_request',
    )
  })

  it('rejects dot-only object key segments that URL parsers normalize', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        fileName: 'path/.././file.txt',
      }),
    ).rejects.toThrow('fileName must not contain dot-only path segments')
  })

  it('rejects B2-invalid object key names before signing', async () => {
    const invalidNames = [
      ['', 'fileName must be a non-empty string'],
      ['/leading-slash', 'fileName cannot start with "/"'],
      ['a//b.txt', 'fileName cannot start with "/"'],
      ['trailing/', 'fileName cannot start with "/"'],
      ['has\u0001ctrl.txt', 'fileName must not contain control characters'],
      ['a'.repeat(1025), 'fileName must be at most 1024 UTF-8 bytes'],
    ] as const

    for (const [fileName, message] of invalidNames) {
      await expect(
        presignS3GetObjectUrl({
          ...basePresignOptions(),
          fileName,
        }),
      ).rejects.toThrow(message)
    }
  })

  it('rejects non-HTTPS endpoints before emitting bearer URLs', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        accountInfo: createMockAccountInfo({
          s3ApiUrl: 'http://s3.us-west-004.backblazeb2.com',
        }),
      }),
    ).rejects.toThrow('S3 presigned URLs require an https: endpoint')
  })

  it('rejects bucket names that can be path-normalized', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        bucketName: '..',
      }),
    ).rejects.toThrow('bucketName must not be "." or ".."')
  })

  it('signs response override query parameters', async () => {
    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentDisposition: 'attachment; filename="safe.txt"',
        responseContentType: 'text/plain',
      }),
    )

    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="safe.txt"',
    )
    expect(url.searchParams.get('response-content-type')).toBe('text/plain')
  })

  it('rejects out-of-range expiry values', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        expiresIn: 604_801,
      }),
    ).rejects.toThrow('expiresIn must be an integer from 1 to 604800 seconds; received 604801')
  })

  it('does not expose secrets or require AWS presigner peer modules', async () => {
    const s3 = await import('./index.ts')
    const url = await s3.presignS3GetObjectUrl(basePresignOptions())

    expect(url).not.toContain('key-secret')
  })

  it('rejects browser-executable response content type overrides', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentType: 'text/html; charset=utf-8',
      }),
    ).rejects.toThrow('responseContentType "text/html" can execute in browsers')
  })

  it('rejects inline response content disposition overrides', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentDisposition: 'inline; filename="preview.html"',
      }),
    ).rejects.toThrow('responseContentDisposition must not force inline rendering')
  })

  it('rejects invalid response expiry dates', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseExpires: new Date('not a date'),
      }),
    ).rejects.toThrow('responseExpires must be a valid Date.')
  })
})

describe('presignGetObjectUrl', () => {
  it('preserves the legacy B2 native positional signature', () => {
    const url = presignGetObjectUrl(
      'https://f004.backblazeb2.com',
      'my-bucket',
      'path/to/file.txt',
      'auth-token-123',
    )

    expect(typeof url).toBe('string')
    expect(url).toContain('/file/my-bucket/path/to/file.txt')
    expect(url).toContain('Authorization=auth-token-123')
  })
})

describe('presignS3PutObjectUrl', () => {
  it('generates a SigV4 PUT URL for direct uploads', async () => {
    useSigningDate()

    const url = new URL(
      await presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        contentType: 'image/jpeg',
        contentLength: 123,
      }),
    )

    expect(url.origin).toBe('https://s3.us-west-004.backblazeb2.com')
    expect(url.pathname).toBe('/my-bucket/uploads/photo.jpg')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.has('X-Amz-Content-Sha256')).toBe(false)
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'key-id/20240102/us-west-004/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20240102T030405Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(url.searchParams.get('x-id')).toBe('PutObject')
    expect(url.toString()).not.toContain('key-secret')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      '95824355640aee3368f99fac75ef7d85f5f379ee8696c3d9de3ed81eb56d9fee',
    )
  })

  it('makes content type affect the signed URL', async () => {
    const withoutContentType = await presignS3PutObjectUrl({
      ...basePresignOptions(),
      fileName: 'uploads/photo.jpg',
    })
    const withContentType = await presignS3PutObjectUrl({
      ...basePresignOptions(),
      fileName: 'uploads/photo.jpg',
      contentType: 'image/jpeg',
    })
    const url = new URL(withContentType)

    expect(withContentType).not.toBe(withoutContentType)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
  })

  it('signs content length when requested', async () => {
    const url = new URL(
      await presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        contentLength: 123,
      }),
    )

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
  })

  it('rejects invalid content lengths', async () => {
    for (const contentLength of [-1, 1.5, Number.NaN]) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName: 'uploads/photo.jpg',
          contentLength,
        }),
      ).rejects.toThrow(
        `contentLength must be a non-negative safe integer; received ${String(contentLength)}.`,
      )
    }
  })

  it('rejects content type values with control characters', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        contentType: 'image/jpeg\nx-amz-meta-evil: yes',
      }),
    ).rejects.toThrow('contentType must not contain control characters')
  })

  it('rejects browser-executable content types by default', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/page.html',
        contentType: 'text/html; charset=utf-8',
      }),
    ).rejects.toThrow('contentType "text/html" can execute in browsers')
  })

  it('allows browser-executable content types with explicit opt-in', async () => {
    const url = new URL(
      await presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/page.html',
        contentType: 'text/html',
        allowBrowserExecutableContentType: true,
      }),
    )

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
  })

  it('rejects B2-invalid object key names before signing', async () => {
    for (const fileName of [
      '',
      '/leading-slash',
      'a//b.txt',
      'trailing/',
      'has\u0001ctrl.txt',
      'a'.repeat(1025),
    ]) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName,
        }),
      ).rejects.toThrow('fileName')
    }
  })

  it('rejects non-HTTPS endpoints before emitting bearer URLs', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        accountInfo: createMockAccountInfo({
          s3ApiUrl: 'http://s3.us-west-004.backblazeb2.com',
        }),
      }),
    ).rejects.toThrow('S3 presigned URLs require an https: endpoint')
  })

  it('rejects bucket names that can be path-normalized', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        bucketName: '..',
      }),
    ).rejects.toThrow('bucketName must not be "." or ".."')
  })

  it('signs metadata headers with normalized key casing', async () => {
    const url = new URL(
      await presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        metadata: {
          Album: 'summer',
          color: 'blue',
        },
      }),
    )

    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
      'host;x-amz-meta-album;x-amz-meta-color',
    )
  })

  it('rejects metadata keys that differ only by case', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        metadata: {
          Foo: 'a',
          foo: 'b',
        },
      }),
    ).rejects.toThrow('metadata key "foo" must not differ only by case.')
  })

  it('rejects metadata keys that are not HTTP header tokens', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        metadata: {
          'bad key': 'value',
        },
      }),
    ).rejects.toThrow('metadata key "bad key" must be a non-empty valid HTTP header token.')
  })

  it('rejects metadata values with control characters', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        metadata: {
          safe: 'a\nx-amz-meta-evil:b',
        },
      }),
    ).rejects.toThrow('signed header values must not contain control characters')
  })

  it('rejects non-string metadata values from JavaScript callers', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        metadata: {
          count: 123,
        } as unknown as Record<string, string>,
      }),
    ).rejects.toThrow('metadata value for "count" must be a string.')
  })
})

describe('presignPutObjectUrl', () => {
  it('delegates to the deprecated PUT alias', async () => {
    const url = new URL(
      await presignPutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/photo.jpg',
        contentType: 'image/jpeg',
      }),
    )

    expect(url.searchParams.get('x-id')).toBe('PutObject')
  })
})

describe('deriveS3RegionFromEndpoint', () => {
  it('returns the region for standard B2 S3 endpoints', () => {
    expect(deriveS3RegionFromEndpoint('https://s3.us-west-004.backblazeb2.com')).toBe('us-west-004')
  })

  it('returns null for custom endpoints', () => {
    expect(deriveS3RegionFromEndpoint('https://s3.example.test')).toBeNull()
  })

  it('returns null for malformed endpoints', () => {
    expect(deriveS3RegionFromEndpoint('s3.us-west-004.backblazeb2.com')).toBeNull()
    expect(deriveS3RegionFromEndpoint('http://[invalid')).toBeNull()
  })
})

describe('createNativeDownloadAuthorizationUrl', () => {
  it('constructs URL with encoded bucket and B2-encoded file name', () => {
    const url = createNativeDownloadAuthorizationUrl(
      'https://f004.backblazeb2.com',
      'my-bucket',
      'path/to/my file#2.txt',
      'auth-token-123',
    )

    expect(url).toContain('/file/my-bucket/path/to/my%20file%232.txt')
  })

  it('includes the authorization token', () => {
    const url = createNativeDownloadAuthorizationUrl(
      'https://f004.backblazeb2.com',
      'bucket',
      'file.txt',
      'secret-token',
    )

    expect(url).toContain('Authorization=secret-token')
  })
})
