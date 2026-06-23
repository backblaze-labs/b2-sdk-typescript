import { describe, expect, it } from 'vitest'

import { presignS3Request } from './sigv4.ts'

const SIGNING_DATE = new Date('2024-01-02T03:04:05Z')

describe('presignS3Request', () => {
  it('canonicalizes duplicate query parameters and combines duplicate signed header names', async () => {
    const url = new URL(
      await presignS3Request(
        'GET',
        {
          endpoint: 'https://s3.us-west-004.backblazeb2.com/root/',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: "special/!*'().txt",
          expiresIn: 60,
          signingDate: SIGNING_DATE,
        },
        [
          ['partNumber', '1'],
          ['partNumber', '2'],
          ['partNumber', '1'],
          ['special', "!*'()"],
          ['x-id', 'GetObject'],
        ],
        [
          ['X-Amz-Meta-Dupe', ' first   value '],
          ['x-amz-meta-dupe', 'second value'],
        ],
      ),
    )
    const combinedHeaderUrl = new URL(
      await presignS3Request(
        'GET',
        {
          endpoint: 'https://s3.us-west-004.backblazeb2.com/root/',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: "special/!*'().txt",
          expiresIn: 60,
          signingDate: SIGNING_DATE,
        },
        [
          ['partNumber', '1'],
          ['partNumber', '2'],
          ['partNumber', '1'],
          ['special', "!*'()"],
          ['x-id', 'GetObject'],
        ],
        [['x-amz-meta-dupe', 'first value,second value']],
      ),
    )

    const query = url.search.slice(1)

    expect(url.pathname).toBe('/root/my-bucket/special/%21%2A%27%28%29.txt')
    expect(query).toContain('partNumber=1&partNumber=1&partNumber=2')
    expect(query).toContain('special=%21%2A%27%28%29')
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host;x-amz-meta-dupe')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      combinedHeaderUrl.searchParams.get('X-Amz-Signature'),
    )
  })

  it('includes non-default endpoint ports in the presigned URL', async () => {
    const url = new URL(
      await presignS3Request(
        'GET',
        {
          endpoint: 'https://s3.us-west-004.backblazeb2.com:8443',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: 'file.txt',
          signingDate: SIGNING_DATE,
        },
        [['x-id', 'GetObject']],
        [],
      ),
    )

    expect(url.host).toBe('s3.us-west-004.backblazeb2.com:8443')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/)
  })

  it('signs bracketed IPv6 literal hosts', async () => {
    const url = new URL(
      await presignS3Request(
        'GET',
        {
          endpoint: 'https://[::1]:8443',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: 'file.txt',
          signingDate: SIGNING_DATE,
        },
        [['x-id', 'GetObject']],
        [],
      ),
    )

    expect(url.host).toBe('[::1]:8443')
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      '2a91722a5bf2dc43b29618531bf8a3ba65105b9e8218de2bd1a0df2150031411',
    )
  })

  it('wraps malformed endpoint URL errors with presign context', async () => {
    let error: unknown
    try {
      await presignS3Request(
        'GET',
        {
          endpoint: 'not a url',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: 'file.txt',
          signingDate: SIGNING_DATE,
        },
        [['x-id', 'GetObject']],
        [],
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe(
      'S3 presigned URL endpoint must be a valid URL; received "<invalid S3 endpoint URL>".',
    )
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(TypeError)
  })

  it('redacts endpoint credentials and routing details from errors', async () => {
    await expect(
      presignS3Request(
        'GET',
        {
          endpoint: 'http://user:secret@s3.us-west-004.backblazeb2.com/private/path?token=abc#frag',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: 'file.txt',
          signingDate: SIGNING_DATE,
        },
        [['x-id', 'GetObject']],
        [],
      ),
    ).rejects.toThrow('http://s3.us-west-004.backblazeb2.com/...')
    await expect(
      presignS3Request(
        'GET',
        {
          endpoint: 'http://user:secret@s3.us-west-004.backblazeb2.com/private/path?token=abc#frag',
          region: 'us-west-004',
          accessKeyId: 'key-id',
          secretAccessKey: 'key-secret',
          bucketName: 'my-bucket',
          fileName: 'file.txt',
          signingDate: SIGNING_DATE,
        },
        [['x-id', 'GetObject']],
        [],
      ),
    ).rejects.not.toThrow(/secret|token=abc|frag|private/)
  })

  it('rejects invalid signing dates and empty bucket names', async () => {
    const options = {
      endpoint: 'https://s3.us-west-004.backblazeb2.com',
      region: 'us-west-004',
      accessKeyId: 'key-id',
      secretAccessKey: 'key-secret',
      bucketName: 'my-bucket',
      fileName: 'file.txt',
    }

    await expect(
      presignS3Request('GET', { ...options, signingDate: Number.NaN }, [['x-id', 'GetObject']], []),
    ).rejects.toThrow('signingDate must be a valid Date or timestamp')
    await expect(
      presignS3Request('GET', { ...options, bucketName: '' }, [['x-id', 'GetObject']], []),
    ).rejects.toThrow('bucketName must be a non-empty string')
  })
})
