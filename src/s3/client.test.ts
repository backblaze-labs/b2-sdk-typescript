import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AccountInfo } from '../auth/account-info.ts'
import {
  type CreateS3CompatibleClientOptions,
  createS3CompatibleClient,
  type S3CompatibleError,
  type S3CompatibleFetch,
} from './index.ts'

const SIGNING_DATE = new Date('2024-01-02T03:04:05Z')
const tempDirs: string[] = []

interface CapturedRequest {
  readonly url: string
  readonly init: RequestInit
}

function createMockAccountInfo(): AccountInfo {
  return {
    getS3ApiUrl: () => 'https://s3.us-west-004.backblazeb2.com',
    getAccountId: () => 'account-id',
    getAuthToken: () => 'auth-token',
    setAuth: () => {},
    getAuth: () => null,
    clear: () => {},
    getApiUrl: () => '',
    getDownloadUrl: () => '',
    getRecommendedPartSize: () => 0,
    getAbsoluteMinimumPartSize: () => 0,
    getAllowedBucketId: () => null,
    getAllowedBucketIds: () => null,
    checkoutUploadUrl: () => null,
    returnUploadUrl: () => {},
    evictUploadUrl: () => {},
    checkoutPartUploadUrl: () => null,
    returnPartUploadUrl: () => {},
    evictPartUploadUrl: () => {},
  }
}

function mockFetch(
  ...responses: Array<
    Response | Promise<Response> | ((request: CapturedRequest) => Response | Promise<Response>)
  >
): {
  readonly fetch: S3CompatibleFetch
  readonly calls: CapturedRequest[]
} {
  const queue = [...responses]
  const calls: CapturedRequest[] = []
  return {
    calls,
    fetch: async (input, init) => {
      const request = { url: String(input), init: init ?? {} }
      calls.push(request)
      const response = queue.shift()
      if (response === undefined) {
        throw new Error(`Unexpected S3 request: ${request.url}`)
      }
      return typeof response === 'function' ? await response(request) : await response
    },
  }
}

function createClient(
  fetch: S3CompatibleFetch,
  options: Partial<
    Pick<CreateS3CompatibleClientOptions, 'downloadRoot' | 'requestTimeoutMs' | 'signingDate'>
  > = {},
) {
  return createS3CompatibleClient({
    accountInfo: createMockAccountInfo(),
    applicationKeyId: 'key-id',
    applicationKey: 'key-secret',
    fetch,
    signingDate: SIGNING_DATE,
    ...options,
  })
}

function headersOf(call: CapturedRequest): Headers {
  return new Headers(call.init.headers)
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'b2-sdk-s3-client-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('S3CompatibleClient', () => {
  it('sends signed HeadBucket requests with AbortSignal support and no secret in the URL', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 200 }))
    const client = createClient(fetch)
    const controller = new AbortController()

    await client.headBucket({ bucket: 'my-bucket', signal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://s3.us-west-004.backblazeb2.com/my-bucket')
    expect(calls[0]?.init.method).toBe('HEAD')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    const headers = headersOf(calls[0] as CapturedRequest)
    expect(headers.get('x-amz-date')).toBe('20240102T030405Z')
    expect(headers.get('x-amz-content-sha256')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(headers.get('authorization')).toContain('Credential=key-id/20240102/us-west-004/s3')
    expect(headers.get('authorization')).not.toContain('key-secret')
    expect(calls[0]?.url).not.toContain('key-secret')
  })

  it('propagates caller AbortSignals into the composed request signal', async () => {
    const controller = new AbortController()
    let composedSignal: AbortSignal | undefined
    const client = createClient(async (_input, init) => {
      composedSignal = init?.signal instanceof AbortSignal ? init.signal : undefined
      controller.abort(new Error('caller stopped'))
      await Promise.resolve()
      return new Response(null, { status: 200 })
    })

    await expect(
      client.headBucket({ bucket: 'my-bucket', signal: controller.signal }),
    ).rejects.toThrow('caller stopped')
    expect(composedSignal?.aborted).toBe(true)
  })

  it('parses bucket location responses', async () => {
    const { fetch } = mockFetch(
      new Response(
        '<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-west-004</LocationConstraint>',
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(client.getBucketLocation({ bucket: 'my-bucket' })).resolves.toEqual({
      locationConstraint: 'us-west-004',
    })
  })

  it('streams GetObject responses to a local path with range and version controls', async () => {
    const tempDir = await makeTempDir()
    const outPath = join(await realpath(tempDir), 'downloaded.txt')
    const { fetch, calls } = mockFetch(
      new Response('hello', {
        status: 206,
        headers: {
          'content-length': '5',
          'content-range': 'bytes 0-4/10',
          'content-type': 'text/plain',
          etag: '"abc"',
          'last-modified': 'Tue, 02 Jan 2024 03:04:05 GMT',
          'x-amz-meta-purpose': 'fixture',
          'x-amz-version-id': 'v1',
        },
      }),
    )
    const client = createClient(fetch, { downloadRoot: tempDir })

    const result = await client.getObject({
      bucket: 'my-bucket',
      key: 'dir/file.txt',
      range: 'bytes=0-4',
      versionId: 'v1',
      saveToPath: 'downloaded.txt',
    })

    expect(result).toMatchObject({
      body: null,
      savedToPath: outPath,
      contentLength: 5,
      contentRange: 'bytes 0-4/10',
      contentType: 'text/plain',
      etag: '"abc"',
      versionId: 'v1',
      metadata: { purpose: 'fixture' },
    })
    expect(result.lastModified?.toISOString()).toBe('2024-01-02T03:04:05.000Z')
    await expect(readFile(outPath, 'utf8')).resolves.toBe('hello')

    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/my-bucket/dir/file.txt')
    expect(url.searchParams.get('versionId')).toBe('v1')
    expect(headersOf(calls[0] as CapturedRequest).get('range')).toBe('bytes=0-4')
  })

  it('returns GetObject response streams and headers without saveToPath', async () => {
    const { fetch } = mockFetch(
      new Response('streamed', {
        status: 200,
        headers: {
          'content-length': '8',
          'content-type': 'text/plain',
          etag: '"stream"',
          'last-modified': 'Tue, 02 Jan 2024 03:04:05 GMT',
          'x-amz-meta-mode': 'stream',
        },
      }),
    )
    const client = createClient(fetch)

    const result = await client.getObject({ bucket: 'my-bucket', key: 'dir/file.txt' })

    expect(result).toMatchObject({
      contentLength: 8,
      contentType: 'text/plain',
      etag: '"stream"',
      metadata: { mode: 'stream' },
    })
    expect(result.savedToPath).toBeUndefined()
    expect(result.body).not.toBeNull()
    if (result.body === null) throw new Error('expected a GetObject body stream')
    expect(result.lastModified?.toISOString()).toBe('2024-01-02T03:04:05.000Z')
    await expect(new Response(result.body).text()).resolves.toBe('streamed')
  })

  it('rejects unsafe saveToPath values before writing outside the download root', async () => {
    const tempDir = await makeTempDir()

    for (const saveToPath of [join(tempDir, 'absolute.txt'), '../escape.txt']) {
      const { fetch } = mockFetch(new Response('nope', { status: 200 }))
      const client = createClient(fetch, { downloadRoot: tempDir })

      await expect(
        client.getObject({ bucket: 'my-bucket', key: 'file.txt', saveToPath }),
      ).rejects.toThrow(/saveToPath/)
    }
  })

  it('rejects existing saveToPath destinations and leaves their contents intact', async () => {
    const tempDir = await makeTempDir()
    const destination = join(tempDir, 'exists.txt')
    await writeFile(destination, 'good')
    const { fetch } = mockFetch(new Response('bad', { status: 200 }))
    const client = createClient(fetch, { downloadRoot: tempDir })

    await expect(
      client.getObject({ bucket: 'my-bucket', key: 'file.txt', saveToPath: 'exists.txt' }),
    ).rejects.toThrow(/already exists/)
    await expect(readFile(destination, 'utf8')).resolves.toBe('good')
  })

  it('rejects saveToPath symlink parent and leaf escapes', async () => {
    const tempDir = await makeTempDir()
    const outsideDir = await makeTempDir()
    await symlink(outsideDir, join(tempDir, 'linked-parent'), 'dir')
    await writeFile(join(tempDir, 'target.txt'), 'target')
    await symlink(join(tempDir, 'target.txt'), join(tempDir, 'leaf-link.txt'), 'file')

    for (const saveToPath of ['linked-parent/escape.txt', 'leaf-link.txt']) {
      const { fetch } = mockFetch(new Response('bad', { status: 200 }))
      const client = createClient(fetch, { downloadRoot: tempDir })

      await expect(
        client.getObject({ bucket: 'my-bucket', key: 'file.txt', saveToPath }),
      ).rejects.toThrow(/saveToPath/)
    }
  })

  it('cleans up temporary saveToPath files when the response stream fails', async () => {
    const tempDir = await makeTempDir()
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('network failed'))
      },
    })
    const { fetch } = mockFetch(new Response(failingBody, { status: 200 }))
    const client = createClient(fetch, { downloadRoot: tempDir })

    await expect(
      client.getObject({ bucket: 'my-bucket', key: 'file.txt', saveToPath: 'partial.txt' }),
    ).rejects.toThrow('network failed')
    await expect(readFile(join(tempDir, 'partial.txt'), 'utf8')).rejects.toThrow()
    await expect(readdir(tempDir)).resolves.toEqual([])
  })

  it('fails stalled saveToPath bodies within the configured timeout', async () => {
    const tempDir = await makeTempDir()
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} })
    const { fetch } = mockFetch(new Response(stalledBody, { status: 200 }))
    const client = createClient(fetch, { downloadRoot: tempDir, requestTimeoutMs: 20 })

    await expect(
      client.getObject({ bucket: 'my-bucket', key: 'file.txt', saveToPath: 'stalled.txt' }),
    ).rejects.toThrow(/stalled|timed out/)
    await expect(readdir(tempDir)).resolves.toEqual([])
  })

  it('lists objects with ListObjectsV2 pagination fields', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        [
          '<ListBucketResult>',
          '<IsTruncated>true</IsTruncated>',
          '<NextContinuationToken>next-token</NextContinuationToken>',
          '<KeyCount>1</KeyCount>',
          '<Contents>',
          '<Key>logs/a.txt</Key>',
          '<LastModified>2024-01-02T03:04:05.000Z</LastModified>',
          '<ETag>&quot;etag&quot;</ETag>',
          '<Size>12</Size>',
          '<StorageClass>STANDARD</StorageClass>',
          '</Contents>',
          '<CommonPrefixes><Prefix>logs/archive/</Prefix></CommonPrefixes>',
          '</ListBucketResult>',
        ].join(''),
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    const result = await client.listObjectsV2({
      bucket: 'my-bucket',
      prefix: 'logs/',
      delimiter: '/',
      maxKeys: 10,
      continuationToken: 'token',
      startAfter: 'logs/0.txt',
    })

    expect(result).toMatchObject({
      isTruncated: true,
      nextContinuationToken: 'next-token',
      keyCount: 1,
      commonPrefixes: ['logs/archive/'],
      objects: [
        {
          key: 'logs/a.txt',
          etag: '"etag"',
          size: 12,
          storageClass: 'STANDARD',
        },
      ],
    })
    expect(result.objects[0]?.lastModified?.toISOString()).toBe('2024-01-02T03:04:05.000Z')

    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('list-type')).toBe('2')
    expect(url.searchParams.get('prefix')).toBe('logs/')
    expect(url.searchParams.get('delimiter')).toBe('/')
    expect(url.searchParams.get('max-keys')).toBe('10')
    expect(url.searchParams.get('continuation-token')).toBe('token')
    expect(url.searchParams.get('start-after')).toBe('logs/0.txt')
  })

  it('does not crash or double-decode poisoned XML numeric entities', async () => {
    const { fetch } = mockFetch(
      new Response(
        [
          '<ListBucketResult>',
          '<IsTruncated>false</IsTruncated>',
          '<Contents><Key>&amp;#x110000;</Key><Size>1</Size></Contents>',
          '<Contents><Key>a&#x110000;b</Key><Size>2</Size></Contents>',
          '<Contents><Key>c&#1114112;d</Key><Size>3</Size></Contents>',
          '</ListBucketResult>',
        ].join(''),
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(client.listObjectsV2({ bucket: 'my-bucket' })).resolves.toMatchObject({
      objects: [{ key: '&#x110000;' }, { key: 'ab' }, { key: 'cd' }],
    })
  })

  it('drops nested markup from XML text fields without regex sanitization', async () => {
    const { fetch } = mockFetch(
      new Response(
        [
          '<ListBucketResult>',
          '<IsTruncated>false</IsTruncated>',
          '<Contents><Key>safe<script>alert(1)</script>name</Key><Size>1</Size></Contents>',
          '<Contents><Key>prefix<script</Key><Size>2</Size></Contents>',
          '</ListBucketResult>',
        ].join(''),
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(client.listObjectsV2({ bucket: 'my-bucket' })).resolves.toMatchObject({
      objects: [{ key: 'safealert(1)name' }, { key: 'prefix' }],
    })
  })

  it('creates multipart uploads with metadata and supported headers', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        '<InitiateMultipartUploadResult><Bucket>my-bucket</Bucket><Key>large.bin</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>',
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(
      client.multipart.create({
        bucket: 'my-bucket',
        key: 'large.bin',
        contentType: 'application/octet-stream',
        metadata: { job: 'mcp' },
        acl: 'private',
        serverSideEncryption: 'AES256',
      }),
    ).resolves.toEqual({ bucket: 'my-bucket', key: 'large.bin', uploadId: 'upload-1' })

    expect(new URL(calls[0]?.url ?? '').searchParams.has('uploads')).toBe(true)
    expect(headersOf(calls[0] as CapturedRequest).get('x-amz-meta-job')).toBe('mcp')
    expect(headersOf(calls[0] as CapturedRequest).get('x-amz-server-side-encryption')).toBe(
      'AES256',
    )
  })

  it('completes multipart uploads with ordered part XML', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        '<CompleteMultipartUploadResult><Location>https://example/large.bin</Location><Bucket>my-bucket</Bucket><Key>large.bin</Key><ETag>"final"</ETag></CompleteMultipartUploadResult>',
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(
      client.multipart.complete({
        bucket: 'my-bucket',
        key: 'large.bin',
        uploadId: 'upload-1',
        parts: [{ partNumber: 1, etag: '"part"' }],
      }),
    ).resolves.toEqual({
      location: 'https://example/large.bin',
      bucket: 'my-bucket',
      key: 'large.bin',
      etag: '"final"',
    })
    expect(calls[0]?.init.body).toBe(
      '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;part&quot;</ETag></Part></CompleteMultipartUpload>',
    )
  })

  it('rejects empty multipart completion part lists before sending a request', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 200 }))
    const client = createClient(fetch)

    await expect(
      client.multipart.complete({
        bucket: 'my-bucket',
        key: 'large.bin',
        uploadId: 'upload-1',
        parts: [],
      }),
    ).rejects.toThrow(/at least one completed part/)
    expect(calls).toHaveLength(0)
  })

  it('aborts multipart uploads and drains successful response bodies', async () => {
    const { fetch } = mockFetch(new Response(null, { status: 204 }))
    const client = createClient(fetch)

    await expect(
      client.multipart.abort({ bucket: 'my-bucket', key: 'large.bin', uploadId: 'upload-1' }),
    ).resolves.toBeUndefined()
  })

  it('lists multipart uploads with pagination and common prefixes', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        [
          '<ListMultipartUploadsResult>',
          '<IsTruncated>true</IsTruncated>',
          '<NextKeyMarker>next-key</NextKeyMarker>',
          '<NextUploadIdMarker>next-upload</NextUploadIdMarker>',
          '<Upload><Key>large.bin</Key><UploadId>upload-1</UploadId><Initiated>2024-01-02T03:04:05.000Z</Initiated><StorageClass>STANDARD</StorageClass><Owner><ID>owner-id</ID></Owner></Upload>',
          '<CommonPrefixes><Prefix>large/</Prefix></CommonPrefixes>',
          '</ListMultipartUploadsResult>',
        ].join(''),
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    const uploads = await client.multipart.listUploads({
      bucket: 'my-bucket',
      prefix: 'large',
      delimiter: '/',
      maxUploads: 5,
      keyMarker: 'a',
      uploadIdMarker: 'b',
    })
    expect(uploads).toMatchObject({
      isTruncated: true,
      nextKeyMarker: 'next-key',
      nextUploadIdMarker: 'next-upload',
      commonPrefixes: ['large/'],
      uploads: [{ key: 'large.bin', uploadId: 'upload-1', owner: { id: 'owner-id' } }],
    })
    const url = new URL(calls[0]?.url ?? '')
    expect(url.searchParams.get('uploads')).toBe('')
    expect(url.searchParams.get('prefix')).toBe('large')
    expect(url.searchParams.get('delimiter')).toBe('/')
    expect(url.searchParams.get('max-uploads')).toBe('5')
    expect(url.searchParams.get('key-marker')).toBe('a')
    expect(url.searchParams.get('upload-id-marker')).toBe('b')
  })

  it('lists multipart parts with a directly reusable numeric marker', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        '<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>"part"</ETag><Size>5</Size></Part><NextPartNumberMarker>1</NextPartNumberMarker></ListPartsResult>',
        { status: 200 },
      ),
      new Response('<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>', {
        status: 200,
      }),
    )
    const client = createClient(fetch)

    const parts = await client.multipart.listParts({
      bucket: 'my-bucket',
      key: 'large.bin',
      uploadId: 'upload-1',
      maxParts: 5,
      partNumberMarker: 1,
    })
    expect(parts).toMatchObject({
      isTruncated: false,
      nextPartNumberMarker: 1,
      parts: [{ partNumber: 1, etag: '"part"', size: 5 }],
    })
    if (parts.nextPartNumberMarker === undefined) {
      throw new Error('expected a next part marker')
    }

    await client.multipart.listParts({
      bucket: 'my-bucket',
      key: 'large.bin',
      uploadId: 'upload-1',
      partNumberMarker: parts.nextPartNumberMarker,
    })
    expect(new URL(calls[1]?.url ?? '').searchParams.get('part-number-marker')).toBe('1')
  })

  it('uploads multipart copy parts with source headers', async () => {
    const { fetch, calls } = mockFetch(
      new Response(
        '<CopyPartResult><LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>"copy"</ETag></CopyPartResult>',
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(
      client.multipart.uploadPartCopy({
        bucket: 'my-bucket',
        key: 'large.bin',
        uploadId: 'upload-1',
        partNumber: 2,
        copySource: 'my-bucket/source.bin?versionId=v1',
        copySourceRange: 'bytes=0-4',
      }),
    ).resolves.toMatchObject({ etag: '"copy"' })
    expect(new URL(calls[0]?.url ?? '').searchParams.get('partNumber')).toBe('2')
    expect(headersOf(calls[0] as CapturedRequest).get('x-amz-copy-source')).toBe(
      'my-bucket/source.bin?versionId=v1',
    )
  })

  it('puts B2-supported lifecycle XML', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 204 }))
    const client = createClient(fetch)

    await expect(
      client.putBucketLifecycle({
        bucket: 'my-bucket',
        rules: [
          {
            id: 'abort-old',
            status: 'Enabled',
            filter: { prefix: 'large/' },
            abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
            expiration: { days: 30 },
            noncurrentVersionExpiration: { noncurrentDays: 7 },
          },
        ],
      }),
    ).resolves.toBeUndefined()
    expect(calls[0]?.init.body).toContain('<AbortIncompleteMultipartUpload>')
    expect(calls[0]?.init.body).toContain('<DaysAfterInitiation>1</DaysAfterInitiation>')
  })

  it('presigns multipart UploadPart URLs without exposing the application key secret', async () => {
    const client = createClient(async () => new Response(null, { status: 200 }))

    const result = await client.presignUploadPart({
      bucket: 'my-bucket',
      key: 'large.bin',
      uploadId: 'upload-1',
      partNumber: 7,
      expiresIn: 900,
      contentLength: 5,
    })

    const url = new URL(result.url)
    expect(result.partNumber).toBe(7)
    expect(url.pathname).toBe('/my-bucket/large.bin')
    expect(url.searchParams.get('partNumber')).toBe('7')
    expect(url.searchParams.get('uploadId')).toBe('upload-1')
    expect(url.searchParams.get('x-id')).toBe('UploadPart')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host')
    expect(url.toString()).not.toContain('key-secret')
  })

  it('rejects invalid multipart create ACL values before sending a request', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 200 }))
    const client = createClient(fetch)

    await expect(
      client.multipart.create({
        bucket: 'my-bucket',
        key: 'large.bin',
        acl: 'public-write' as 'private',
      }),
    ).rejects.toThrow(/acl/)
    expect(calls).toHaveLength(0)
  })

  it('rejects B2-unsupported lifecycle rule states before sending a request', async () => {
    const { fetch, calls } = mockFetch(new Response(null, { status: 200 }))
    const client = createClient(fetch)

    await expect(
      client.putBucketLifecycle({
        bucket: 'my-bucket',
        rules: [{ id: 'disabled', status: 'Disabled' as 'Enabled' }],
      }),
    ).rejects.toThrow(/status/)
    await expect(
      client.putBucketLifecycle({
        bucket: 'my-bucket',
        rules: [
          {
            id: 'false-marker',
            status: 'Enabled',
            expiration: { expiredObjectDeleteMarker: false as true },
          },
        ],
      }),
    ).rejects.toThrow(/expiredObjectDeleteMarker/)
    await expect(
      client.putBucketLifecycle({
        bucket: 'my-bucket',
        rules: [{ id: 'empty-expiration', status: 'Enabled', expiration: {} }],
      }),
    ).rejects.toThrow(/expiration requires/)
    expect(calls).toHaveLength(0)
  })

  it('times out fetches that never resolve', async () => {
    const client = createClient(() => new Promise<Response>(() => {}), { requestTimeoutMs: 20 })

    await expect(client.headBucket({ bucket: 'my-bucket' })).rejects.toThrow(/timed out/)
  })

  it('cancels response bodies for void-returning helpers', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const { fetch } = mockFetch(new Response(body, { status: 200 }))
    const client = createClient(fetch)

    await client.putBucketLifecycle({
      bucket: 'my-bucket',
      rules: [{ id: 'abort-old', status: 'Enabled', expiration: { days: 1 } }],
    })

    expect(cancelled).toBe(true)
  })

  it('maps S3 error XML without including credential material in the message', async () => {
    const { fetch } = mockFetch(
      new Response('<Error><Code>NoSuchBucket</Code><Message>missing bucket</Message></Error>', {
        status: 404,
        headers: { 'x-amz-request-id': 'request-1' },
      }),
    )
    const client = createClient(fetch)

    await expect(client.headBucket({ bucket: 'my-bucket' })).rejects.toMatchObject({
      name: 'S3CompatibleError',
      status: 404,
      code: 'NoSuchBucket',
      message: 'missing bucket',
      requestId: 'request-1',
    } satisfies Partial<S3CompatibleError>)
  })

  it('throws embedded S3 errors returned by CompleteMultipartUpload with HTTP 200', async () => {
    const { fetch } = mockFetch(
      new Response(
        '<Error><Code>InvalidPart</Code><Message>part &amp;#x110000; mismatch</Message><RequestId>request-2</RequestId></Error>',
        { status: 200 },
      ),
    )
    const client = createClient(fetch)

    await expect(
      client.multipart.complete({
        bucket: 'my-bucket',
        key: 'large.bin',
        uploadId: 'upload-1',
        parts: [{ partNumber: 1, etag: '"etag"' }],
      }),
    ).rejects.toMatchObject({
      status: 200,
      code: 'InvalidPart',
      message: 'part &#x110000; mismatch',
      requestId: 'request-2',
    } satisfies Partial<S3CompatibleError>)
  })
})
