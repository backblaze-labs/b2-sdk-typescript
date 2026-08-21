import { describe, expect, it } from 'vitest'
import { B2BucketConfigurationError } from './errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from './http/transport.ts'
import { RawClient } from './raw/index.ts'
import { recordingTransport } from './test-utils/index.ts'
import { BucketType, CORS_MAX_AGE_SECONDS_MAX, CorsOperation } from './types/bucket.ts'
import { FileAction, HIDE_MARKER_CONTENT_TYPE } from './types/file.ts'
import { bucketId } from './types/ids.ts'
import type { CreateKeyRequest } from './types/key.ts'

function jsonResponse(value: unknown): HttpResponse {
  return {
    status: 200,
    headers: new Headers(),
    body: null,
    json: <T>() => Promise.resolve(value as T),
    text: () => Promise.resolve(JSON.stringify(value)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }
}

describe('RawClient bucket configuration validation', () => {
  it('passes valid bucketInfo and CORS rules through bucket create/update', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        return jsonResponse({})
      },
    }
    const raw = new RawClient({ transport })
    const bucketInfo: Record<string, string> = {}
    for (let i = 0; i < 12; i++) bucketInfo[`key_${i}`] = 'value'
    const corsRules = [
      {
        allowedOperations: [CorsOperation.B2DownloadFileByName],
        allowedOrigins: ['https://example.com'],
        corsRuleName: 'rule-1',
        maxAgeSeconds: 3600,
      },
    ]

    await raw.createBucket('https://api.example.test', 'auth', {
      accountId: 'account' as never,
      bucketInfo,
      bucketName: 'valid-bucket',
      bucketType: BucketType.AllPrivate,
      corsRules,
    })
    await raw.updateBucket('https://api.example.test', 'auth', {
      accountId: 'account' as never,
      bucketId: bucketId('bucket'),
      bucketInfo,
      corsRules,
    })

    expect(requests).toHaveLength(2)
    expect(JSON.parse(requests[0]?.body as string)).toMatchObject({
      bucketInfo,
      corsRules,
    })
    expect(JSON.parse(requests[1]?.body as string)).toMatchObject({
      bucketInfo,
      corsRules,
    })
  })

  it('rejects invalid bucket configuration before transport', async () => {
    const { seenRequests, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(
      raw.createBucket('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        bucketInfo: { 'b2-system': 'value' },
        bucketName: 'invalid-bucket',
        bucketType: BucketType.AllPrivate,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_bucket_info',
      field: 'bucketInfo',
      name: 'B2BucketConfigurationError',
      status: 400,
    })

    await expect(
      raw.updateBucket('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        bucketId: bucketId('bucket'),
        corsRules: [
          {
            allowedHeaders: null,
            allowedOperations: ['s3_post'] as never,
            allowedOrigins: ['https://example.com'],
            corsRuleName: 'rule-1',
            exposeHeaders: null,
            maxAgeSeconds: 3600,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(B2BucketConfigurationError)

    await expect(
      raw.updateBucket('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        bucketId: bucketId('bucket'),
        corsRules: [
          {
            allowedOperations: [CorsOperation.B2DownloadFileByName],
            allowedOrigins: ['https://example.com'],
            corsRuleName: 'rule-2',
            maxAgeSeconds: CORS_MAX_AGE_SECONDS_MAX + 1,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      field: 'corsRules',
      name: 'B2BucketConfigurationError',
      status: 400,
    })

    await expect(
      raw.updateBucket('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        bucketId: bucketId('bucket'),
        corsRules: [
          {
            allowedOperations: [CorsOperation.B2DownloadFileByName],
            allowedOrigins: ['https://example.com'],
            corsRuleName: 'rule-3\n',
            maxAgeSeconds: 3600,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      field: 'corsRules',
      name: 'B2BucketConfigurationError',
      status: 400,
    })

    expect(seenRequests).toEqual([])
  })
})

describe('RawClient list request controls', () => {
  it('normalizes the deprecated createKey bucketId alias to bucketIds', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        return jsonResponse({
          keyName: 'alias-key',
          applicationKeyId: 'key-id',
          applicationKey: 'secret',
          capabilities: [],
          accountId: 'account',
          expirationTimestamp: null,
          bucketIds: ['bucket'],
          namePrefix: null,
          options: [],
        })
      },
    }
    const raw = new RawClient({ transport })

    const key = await raw.createKey('https://api.example.test', 'auth', {
      accountId: 'account' as never,
      capabilities: [],
      keyName: 'alias-key',
      bucketId: 'bucket' as never,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/b2api/v4/b2_create_key')
    const body = JSON.parse(requests[0]?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ bucketIds: ['bucket'] })
    expect('bucketId' in body).toBe(false)
    expect(key.bucketIds).toEqual(['bucket'])
    expect(key.bucketId).toBe('bucket')
  })

  it('rejects conflicting createKey bucketId and bucketIds inputs before transport', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        return jsonResponse({})
      },
    }
    const raw = new RawClient({ transport })

    // @ts-expect-error bucketId and bucketIds are mutually exclusive.
    const invalidCreateKeyRequest: CreateKeyRequest = {
      accountId: 'account' as never,
      capabilities: [],
      keyName: 'invalid',
      bucketIds: null,
      bucketId: bucketId('bucket'),
    }
    expect(invalidCreateKeyRequest).toBeDefined()

    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'conflict',
        bucketIds: null,
        bucketId: 'bucket' as never,
      } as unknown as CreateKeyRequest),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'mismatch',
        bucketIds: ['bucket-a' as never],
        bucketId: 'bucket-b' as never,
      } as unknown as CreateKeyRequest),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    const untrusted = { bucketIds: ['user-bucket' as never] }
    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'safe-merge',
        ...untrusted,
        bucketId: 'trusted-bucket' as never,
      } as unknown as CreateKeyRequest),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    expect(requests).toEqual([])
  })

  it('passes abort signals and retry through listUnfinishedLargeFiles and listParts', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        if (request.url.endsWith('/b2_list_parts')) {
          return jsonResponse({ parts: [], nextPartNumber: null })
        }
        return jsonResponse({ files: [], nextFileId: null })
      },
    }
    const raw = new RawClient({ transport })
    const controller = new AbortController()
    const retry = { maxRetries: 0 }

    await raw.listUnfinishedLargeFiles(
      'https://api.example.test',
      'auth',
      { bucketId: 'bucket' as never },
      { signal: controller.signal, retry },
    )
    await raw.listParts(
      'https://api.example.test',
      'auth',
      { fileId: 'large-file' as never },
      { signal: controller.signal, retry },
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.signal).toBe(controller.signal)
    expect(requests[0]?.retry).toBe(retry)
    expect(requests[1]?.signal).toBe(controller.signal)
    expect(requests[1]?.retry).toBe(retry)
  })

  it("normalizes the 'none' contentSha1 sentinel for unfinished large files", async () => {
    const transport: HttpTransport = {
      async send(request) {
        const body = {
          fileId: 'large-file' as never,
          fileName: 'large.bin',
          accountId: 'account',
          bucketId: 'bucket' as never,
          contentType: 'application/octet-stream',
          contentSha1: 'none',
          fileInfo: {},
        }
        if (request.url.endsWith('/b2_list_unfinished_large_files')) {
          return jsonResponse({ files: [body], nextFileId: null })
        }
        return jsonResponse(body)
      },
    }
    const raw = new RawClient({ transport })

    const started = await raw.startLargeFile('https://api.example.test', 'auth', {
      bucketId: 'bucket' as never,
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
    })
    const unfinished = await raw.listUnfinishedLargeFiles('https://api.example.test', 'auth', {
      bucketId: 'bucket' as never,
    })

    expect(started.contentSha1).toBeNull()
    expect(unfinished.files[0]?.contentSha1).toBeNull()
  })

  it('preserves live-shaped hide marker content type in listFileVersions', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          files: [
            {
              accountId: 'account',
              action: FileAction.Hide,
              bucketId: 'bucket',
              contentLength: 0,
              contentMd5: null,
              contentSha1: 'none',
              contentType: HIDE_MARKER_CONTENT_TYPE,
              fileId: 'hide-file-id',
              fileInfo: {},
              fileName: 'hidden.txt',
              uploadTimestamp: 1,
            },
          ],
          nextFileName: null,
          nextFileId: null,
        })
      },
    }
    const raw = new RawClient({ transport })

    const versions = await raw.listFileVersions('https://api.example.test', 'auth', {
      bucketId: 'bucket' as never,
    })

    expect(versions.files[0]?.action).toBe(FileAction.Hide)
    expect(versions.files[0]?.contentType).toBe(HIDE_MARKER_CONTENT_TYPE)
    expect(versions.files[0]?.contentSha1).toBeNull()
  })
})
