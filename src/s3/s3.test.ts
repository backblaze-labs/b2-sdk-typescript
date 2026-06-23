import { afterEach, describe, expect, it } from 'vitest'

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
const REAL_DATE = globalThis.Date
const BROWSER_EXECUTABLE_CONTENT_TYPES = [
  'text/html; charset=utf-8',
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
  'application/custom+xml',
] as const
const B2_INVALID_BUCKET_NAMES = [
  ['short', 'bucketName must be 6-63 characters.'],
  ['a'.repeat(64), 'bucketName must be 6-63 characters.'],
  ['-badbucket', 'bucketName must contain only letters, digits, hyphens, and periods'],
  ['badbucket-', 'bucketName must contain only letters, digits, hyphens, and periods'],
  ['bad_bucket', 'bucketName must contain only letters, digits, hyphens, and periods'],
  ['bad..bucket', 'bucketName must contain only letters, digits, hyphens, and periods'],
  ['b2-secret', 'bucketName cannot start with the reserved prefix "b2-".'],
] as const

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
  const fixedTime = SIGNING_DATE.getTime()
  class FixedDate extends REAL_DATE {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixedTime)
      } else if (args.length === 1) {
        super(args[0] as string | number | Date)
      } else {
        super(...(args as [number, number, number?, number?, number?, number?, number?]))
      }
    }

    static override now(): number {
      return fixedTime
    }
  }

  Object.defineProperty(globalThis, 'Date', {
    configurable: true,
    value: FixedDate as DateConstructor,
    writable: true,
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'Date', {
    configurable: true,
    value: REAL_DATE,
    writable: true,
  })
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
    ).toThrow('Pass an explicit `region` option')
  })

  it('redacts non-standard endpoint details in region errors', () => {
    const accountInfo = createMockAccountInfo({
      s3ApiUrl: 'https://user:secret@proxy.example/private/path?token=abc#frag',
    })

    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
      }),
    ).toThrow('https://proxy.example/...')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
      }),
    ).not.toThrow(/secret|token=abc|frag|private/)
  })

  it('validates credentials and explicit regions before returning config', () => {
    const accountInfo = createMockAccountInfo()

    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: '',
        applicationKey: 'test-key',
      }),
    ).toThrow('applicationKeyId must be a non-empty string')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: '   ',
        applicationKey: 'test-key',
      }),
    ).toThrow('applicationKeyId must be a non-empty string')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: undefined,
      } as unknown as Parameters<typeof createS3ClientConfig>[0]),
    ).toThrow('applicationKey must be a non-empty string')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: '   ',
      }),
    ).toThrow('applicationKey must be a non-empty string')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        region: '',
      }),
    ).toThrow('region must be a non-empty string')
    expect(() =>
      createS3ClientConfig({
        accountInfo,
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        region: '   ',
      }),
    ).toThrow('region must be a non-empty string')
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
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD')
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
    expect(signature).toBe('4314cf0a273b0890980eed707afb1720f20aeefcfc5f6426a0f0543f236c8f11')

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

  it('rejects missing and empty S3 credential inputs before returning URLs', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        applicationKeyId: '',
      }),
    ).rejects.toThrow('applicationKeyId must be a non-empty string')
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        applicationKey: undefined,
      } as unknown as Parameters<typeof presignS3GetObjectUrl>[0]),
    ).rejects.toThrow('applicationKey must be a non-empty string')
  })

  it('omits an explicit default TLS port from the signed host header', async () => {
    useSigningDate()

    const standardUrl = new URL(await presignS3GetObjectUrl(basePresignOptions()))
    const defaultPortUrl = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        accountInfo: createMockAccountInfo({
          s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com:443',
        }),
      }),
    )

    expect(defaultPortUrl.host).toBe('s3.us-west-004.backblazeb2.com')
    expect(defaultPortUrl.searchParams.get('X-Amz-Signature')).toBe(
      standardUrl.searchParams.get('X-Amz-Signature'),
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

  it('allows slash-boundary object keys before signing', async () => {
    for (const fileName of ['/leading-slash', 'a//b.txt', 'trailing/']) {
      const url = new URL(
        await presignS3GetObjectUrl({
          ...basePresignOptions(),
          fileName,
        }),
      )

      expect(url.pathname).toContain(fileName)
    }
  })

  it('rejects B2-invalid object key names before signing', async () => {
    const invalidNames = [
      ['', 'fileName must be a non-empty string'],
      ['.', 'fileName cannot be exactly "." or ".."'],
      ['..', 'fileName cannot be exactly "." or ".."'],
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

  it('rejects B2-invalid bucket names before signing', async () => {
    for (const [bucketName, message] of B2_INVALID_BUCKET_NAMES) {
      await expect(
        presignS3GetObjectUrl({
          ...basePresignOptions(),
          bucketName,
        }),
      ).rejects.toThrow(message)
    }
  })

  it('accepts dotted bucket names for path-style S3 GET URLs', async () => {
    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        bucketName: 'bucket.name',
      }),
    )

    expect(url.pathname).toBe('/bucket.name/path/to/file.txt')
  })

  it('signs response override query parameters', async () => {
    const expires = new Date('2024-03-04T05:06:07Z')
    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        versionId:
          '4_zf1f51fb5fe4dcb2f845d0c1b_f118c4446a350b0da_d20240102_m030405_c004_v0402000_t0001_u01704168845000',
        responseCacheControl: 'private, max-age=60',
        responseContentDisposition: 'attachment; filename="safe.txt"',
        responseContentEncoding: 'gzip',
        responseContentLanguage: 'en-US',
        responseContentType: 'text/plain',
        responseExpires: expires,
      }),
    )

    expect(url.searchParams.get('versionId')).toBe(
      '4_zf1f51fb5fe4dcb2f845d0c1b_f118c4446a350b0da_d20240102_m030405_c004_v0402000_t0001_u01704168845000',
    )
    expect(url.searchParams.get('response-cache-control')).toBe('private, max-age=60')
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="safe.txt"',
    )
    expect(url.searchParams.get('response-content-encoding')).toBe('gzip')
    expect(url.searchParams.get('response-content-language')).toBe('en-US')
    expect(url.searchParams.get('response-content-type')).toBe('text/plain')
    expect(url.searchParams.get('response-expires')).toBe(expires.toUTCString())
  })

  it('rejects out-of-range expiry values', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        expiresIn: 604_801,
      }),
    ).rejects.toThrow('expiresIn must be an integer from 1 to 604800 seconds; received 604801')
  })

  it('rejects version IDs with control characters before signing', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        versionId: 'safe\nx-amz-meta-evil: yes',
      }),
    ).rejects.toThrow('versionId must not contain control characters')
  })

  it('does not expose secrets or require AWS presigner peer modules', async () => {
    const s3 = await import('./index.ts')
    const url = await s3.presignS3GetObjectUrl(basePresignOptions())

    expect(url).not.toContain('key-secret')
  })

  it('rejects browser-executable response content type overrides', async () => {
    for (const responseContentType of BROWSER_EXECUTABLE_CONTENT_TYPES) {
      await expect(
        presignS3GetObjectUrl({
          ...basePresignOptions(),
          responseContentType,
        }),
      ).rejects.toThrow('responseContentType')
    }
  })

  it('allows browser-executable response content type overrides with explicit opt-in', async () => {
    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentType: 'text/html',
        allowBrowserExecutableResponseContentType: true,
      }),
    )

    expect(url.searchParams.get('response-content-type')).toBe('text/html')
  })

  it('rejects empty response content type overrides', async () => {
    for (const responseContentType of ['', '   ', '; charset=utf-8']) {
      await expect(
        presignS3GetObjectUrl({
          ...basePresignOptions(),
          responseContentType,
        }),
      ).rejects.toThrow('responseContentType must include a non-empty media type.')
    }
  })

  it('rejects malformed response content type overrides', async () => {
    for (const responseContentType of ['text /html', 'text/html text/plain']) {
      await expect(
        presignS3GetObjectUrl({
          ...basePresignOptions(),
          responseContentType,
        }),
      ).rejects.toThrow('responseContentType must include a valid media type.')
    }
  })

  it('rejects inline response content disposition overrides', async () => {
    await expect(
      presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentDisposition: 'inline; filename="preview.html"',
      }),
    ).rejects.toThrow('responseContentDisposition must not force inline rendering')
  })

  it('allows inline response content disposition overrides with explicit opt-in', async () => {
    const url = new URL(
      await presignS3GetObjectUrl({
        ...basePresignOptions(),
        responseContentDisposition: 'inline; filename="preview.pdf"',
        allowInlineResponseContentDisposition: true,
      }),
    )

    expect(url.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="preview.pdf"',
    )
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
    expect(new URL(url).pathname).toBe('/file/my-bucket/path%2Fto%2Ffile.txt')
    expect(url).toContain('/file/my-bucket/path%2Fto%2Ffile.txt')
    expect(url).toContain('Authorization=auth-token-123')
  })

  it('accepts legacy file names encoded as one URL component', () => {
    for (const fileName of ['/leading-slash', 'a//b.txt', 'trailing/', 'allowed/../private.txt']) {
      const url = presignGetObjectUrl(
        'https://f004.backblazeb2.com',
        'my-bucket',
        fileName,
        'auth-token-123',
      )

      expect(new URL(url).pathname).toBe(`/file/my-bucket/${encodeURIComponent(fileName)}`)
    }
  })

  it('rejects dot-only legacy native file names', () => {
    for (const fileName of ['.', '..']) {
      expect(() =>
        presignGetObjectUrl(
          'https://f004.backblazeb2.com',
          'my-bucket',
          fileName,
          'auth-token-123',
        ),
      ).toThrow('fileName cannot be exactly "." or ".."')
    }
  })

  it('rejects unsafe legacy native URL bucket names', () => {
    expect(() =>
      presignGetObjectUrl('https://f004.backblazeb2.com', '..', 'file.txt', 'auth-token-123'),
    ).toThrow('bucketName must not be "." or ".."')
  })

  it('rejects unsafe legacy native download URL bases before returning bearer tokens', () => {
    for (const [downloadUrl, message] of [
      ['http://f004.backblazeb2.com', 'require an https: downloadUrl'],
      ['https://user:pass@f004.backblazeb2.com', 'must not include userinfo'],
      ['https://user:pass@attacker.example', 'must not include userinfo'],
      ['https://f004.backblazeb2.com?steal=', 'must not include query or fragment'],
      ['https://attacker.example?steal=', 'must not include query or fragment'],
      ['https://f004.backblazeb2.com#steal', 'must not include query or fragment'],
      ['https://attacker.example#steal', 'must not include query or fragment'],
      ['https://f004.backblazeb2.com/base', 'must not include a path'],
      ['https://attacker.example', 'require a Backblaze download host'],
    ] as const) {
      expect(() => presignGetObjectUrl(downloadUrl, 'bucket', 'file.txt', 'secret-token')).toThrow(
        message,
      )
    }
  })

  it('rejects invalid compatibility duration values', () => {
    expect(() =>
      presignGetObjectUrl(
        'https://f004.backblazeb2.com',
        'bucket',
        'file.txt',
        'secret-token',
        1.5,
      ),
    ).toThrow('validDurationInSeconds must be a non-negative safe integer')
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
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'key-id/20240102/us-west-004/s3/aws4_request',
    )
    expect(url.searchParams.get('X-Amz-Date')).toBe('20240102T030405Z')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
    expect(url.searchParams.get('x-id')).toBe('PutObject')
    expect(url.toString()).not.toContain('key-secret')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      '622f0e7d4cd7771cc7c2c277a345f529542fdf0f24573a271b5e861ba4a68201',
    )
  })

  it('makes content type affect the signed URL', async () => {
    useSigningDate()

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

  it('rejects missing and empty S3 credential inputs before returning URLs', async () => {
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        applicationKeyId: '',
      }),
    ).rejects.toThrow('applicationKeyId must be a non-empty string')
    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        applicationKey: undefined,
      } as unknown as Parameters<typeof presignS3PutObjectUrl>[0]),
    ).rejects.toThrow('applicationKey must be a non-empty string')
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

  it('rejects empty content type values', async () => {
    for (const contentType of ['', '   ', '; charset=utf-8']) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName: 'uploads/photo.jpg',
          contentType,
        }),
      ).rejects.toThrow('contentType must include a non-empty media type.')
    }

    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/page.html',
        contentType: '   ',
        allowBrowserExecutableContentType: true,
      }),
    ).rejects.toThrow('contentType must include a non-empty media type.')
  })

  it('rejects malformed content type values', async () => {
    for (const contentType of ['text /html', 'text/html text/plain']) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName: 'uploads/page.html',
          contentType,
        }),
      ).rejects.toThrow('contentType must include a valid media type.')
    }

    await expect(
      presignS3PutObjectUrl({
        ...basePresignOptions(),
        fileName: 'uploads/page.html',
        contentType: 'text /html',
        allowBrowserExecutableContentType: true,
      }),
    ).rejects.toThrow('contentType must include a valid media type.')
  })

  it('rejects browser-executable content types by default', async () => {
    for (const contentType of BROWSER_EXECUTABLE_CONTENT_TYPES) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName: 'uploads/page.html',
          contentType,
        }),
      ).rejects.toThrow('contentType')
    }
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

  it('allows slash-boundary object keys before signing', async () => {
    for (const fileName of ['/leading-slash', 'a//b.txt', 'trailing/']) {
      const url = new URL(
        await presignS3PutObjectUrl({
          ...basePresignOptions(),
          fileName,
        }),
      )

      expect(url.pathname).toContain(fileName)
    }
  })

  it('rejects B2-invalid object key names before signing', async () => {
    for (const fileName of ['', '.', '..', 'has\u0001ctrl.txt', 'a'.repeat(1025)]) {
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

  it('rejects B2-invalid bucket names before signing', async () => {
    for (const [bucketName, message] of B2_INVALID_BUCKET_NAMES) {
      await expect(
        presignS3PutObjectUrl({
          ...basePresignOptions(),
          bucketName,
        }),
      ).rejects.toThrow(message)
    }
  })

  it('accepts dotted bucket names for path-style S3 PUT URLs', async () => {
    const url = new URL(
      await presignS3PutObjectUrl({
        ...basePresignOptions(),
        bucketName: 'bucket.name',
      }),
    )

    expect(url.pathname).toBe('/bucket.name/path/to/file.txt')
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

  it('accepts dotted bucket names for native download URLs', () => {
    const url = createNativeDownloadAuthorizationUrl(
      'https://f004.backblazeb2.com',
      'bucket.name',
      'file.txt',
      'auth-token-123',
    )

    expect(new URL(url).pathname).toBe('/file/bucket.name/file.txt')
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

  it('rejects unsafe native download URL bases before returning bearer tokens', () => {
    for (const [downloadUrl, message] of [
      ['http://f004.backblazeb2.com', 'require an https: downloadUrl'],
      ['https://user:pass@f004.backblazeb2.com', 'must not include userinfo'],
      ['https://user:pass@attacker.example', 'must not include userinfo'],
      ['https://f004.backblazeb2.com?steal=', 'must not include query or fragment'],
      ['https://attacker.example?steal=', 'must not include query or fragment'],
      ['https://f004.backblazeb2.com#steal', 'must not include query or fragment'],
      ['https://attacker.example#steal', 'must not include query or fragment'],
      ['https://f004.backblazeb2.com/base', 'must not include a path'],
      ['https://attacker.example', 'require a Backblaze download host'],
    ] as const) {
      expect(() =>
        createNativeDownloadAuthorizationUrl(downloadUrl, 'bucket', 'file.txt', 'secret-token'),
      ).toThrow(message)
    }
  })

  it('rejects file names and bucket names that can normalize outside the path prefix', () => {
    for (const fileName of [
      'allowed/../private.txt',
      'path/.././file.txt',
      '.',
      '..',
      '/leading-slash',
      'a//b.txt',
      'trailing/',
      'has\u0001ctrl.txt',
    ]) {
      expect(() =>
        createNativeDownloadAuthorizationUrl(
          'https://f004.backblazeb2.com',
          'bucket',
          fileName,
          'secret-token',
        ),
      ).toThrow()
    }

    for (const bucketName of ['..', '.', 'has/slash', 'has\u0001ctrl']) {
      expect(() =>
        createNativeDownloadAuthorizationUrl(
          'https://f004.backblazeb2.com',
          bucketName,
          'file.txt',
          'secret-token',
        ),
      ).toThrow()
    }
  })

  it('rejects B2-invalid bucket names before returning native URLs', () => {
    for (const [bucketName, message] of B2_INVALID_BUCKET_NAMES) {
      expect(() =>
        createNativeDownloadAuthorizationUrl(
          'https://f004.backblazeb2.com',
          bucketName,
          'file.txt',
          'secret-token',
        ),
      ).toThrow(message)
    }
  })

  it('rejects invalid compatibility duration values', () => {
    for (const validDurationInSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createNativeDownloadAuthorizationUrl(
          'https://f004.backblazeb2.com',
          'bucket',
          'file.txt',
          'secret-token',
          validDurationInSeconds,
        ),
      ).toThrow(
        `validDurationInSeconds must be a non-negative safe integer; received ${String(
          validDurationInSeconds,
        )}.`,
      )
    }
  })
})
