import { describe, expect, it } from 'vitest'
import { B2RealmConfigurationError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import {
  EncryptionAlgorithm,
  EncryptionKey,
  EncryptionMode,
  SSE_C_KEY_REDACTION,
} from '../types/encryption.ts'
import { bucketId, fileId, largeFileId } from '../types/ids.ts'
import { EventType } from '../types/notifications.ts'
import { RawClient } from './index.ts'
import { b2Url, isB2ApiVersion } from './url.ts'

describe('b2Url', () => {
  it('builds versioned b2api and backup API paths', () => {
    expect(
      b2Url('https://api.example.test', {
        prefix: 'b2api',
        version: 'v3',
        endpoint: 'b2_list_buckets',
      }),
    ).toBe('https://api.example.test/b2api/v3/b2_list_buckets')
    expect(
      b2Url('https://api.example.test/', {
        prefix: '/api/backup/',
        version: 'v1',
        endpoint: '/backup_endpoint',
      }),
    ).toBe('https://api.example.test/api/backup/v1/backup_endpoint')
  })

  it('omits the version segment when none is provided', () => {
    expect(b2Url('https://api.example.test/root', { endpoint: 'partner_endpoint' })).toBe(
      'https://api.example.test/root/b2api/partner_endpoint',
    )
  })

  it('returns the normalized base URL when every path segment is empty', () => {
    expect(b2Url('https://api.example.test/root/', { prefix: '', endpoint: '' })).toBe(
      'https://api.example.test/root',
    )
  })

  it('rejects unsafe path and version segments', () => {
    expect(isB2ApiVersion('v3')).toBe(true)
    expect(isB2ApiVersion('v1.5')).toBe(false)

    const unsafeOptions = [
      { endpoint: '../v3/b2_delete_file' },
      { endpoint: '..' },
      { endpoint: '%2e%2e' },
      { endpoint: '%2e%2e%2fv3%2fb2_delete_file' },
      { endpoint: 'ignored\\b2_delete_file' },
      { endpoint: 'ignored%5cb2_delete_file' },
      { endpoint: 'ignored%5Cb2_delete_file' },
      { endpoint: 'b2_delete_file?fileId=1' },
      { endpoint: 'b2_delete_file#fragment' },
      { endpoint: 'b2_delete_file%3ffileId=1' },
      { prefix: 'api/../backup', endpoint: 'backup_endpoint' },
      { prefix: 'api/%2e%2e/backup', endpoint: 'backup_endpoint' },
      { prefix: 'api\\backup', endpoint: 'backup_endpoint' },
      { prefix: 'api/%5c/backup', endpoint: 'backup_endpoint' },
      { prefix: 'api//backup', endpoint: 'backup_endpoint' },
      { version: 'v1\\' as never, endpoint: 'backup_endpoint' },
      { version: 'v1%5c' as never, endpoint: 'backup_endpoint' },
      { version: 'v1.5', endpoint: 'backup_endpoint' },
    ] as const

    for (const options of unsafeOptions) {
      expect(() => b2Url('https://api.example.test', options)).toThrow(TypeError)
    }
  })
})

describe('RawClient authorizeAccount', () => {
  it('uses the v4 authorize endpoint', async () => {
    const seenUrls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenUrls.push(request.url)
        return jsonResponse({
          accountId: 'account',
          authorizationToken: 'token',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api.example.com',
              downloadUrl: 'https://download.example.com',
              s3ApiUrl: 'https://s3.example.com',
              absoluteMinimumPartSize: 5_000_000,
              recommendedPartSize: 100_000_000,
              allowed: { capabilities: [], buckets: null, namePrefix: null },
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new RawClient({ transport })

    const auth = await raw.authorizeAccount('key-id', 'key-secret', 'https://api.example.com')

    expect(seenUrls).toEqual(['https://api.example.com/b2api/v4/b2_authorize_account'])
    expect(auth.apiInfo.storageApi.infoType).toBe('storageApi')
    expect(auth.apiInfo.storageApi.bucketId).toBeNull()
    expect(auth.apiInfo.storageApi.bucketName).toBeNull()
    expect(auth.apiInfo.storageApi.namePrefix).toBeNull()
    expect(auth.apiInfo.storageApi.allowed.buckets).toBeNull()
    expect(auth.apiInfo.storageApi.allowed.bucketId).toBeNull()
    expect(auth.apiInfo.storageApi.allowed.bucketName).toBeNull()
  })

  it('normalizes a single v4 allowed bucket to deprecated aliases', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: 'account',
          authorizationToken: 'token',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api.example.com',
              downloadUrl: 'https://download.example.com',
              s3ApiUrl: 'https://s3.example.com',
              absoluteMinimumPartSize: 5_000_000,
              recommendedPartSize: 100_000_000,
              allowed: {
                capabilities: [],
                buckets: [{ id: bucketId('bucket-a'), name: 'bucket-a-name' }],
                namePrefix: 'photos/',
              },
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new RawClient({ transport })

    const auth = await raw.authorizeAccount('key-id', 'key-secret', 'https://api.example.com')

    expect(auth.apiInfo.storageApi.allowed.buckets).toEqual([
      { id: bucketId('bucket-a'), name: 'bucket-a-name' },
    ])
    expect(auth.apiInfo.storageApi.bucketId).toBe(bucketId('bucket-a'))
    expect(auth.apiInfo.storageApi.bucketName).toBe('bucket-a-name')
    expect(auth.apiInfo.storageApi.namePrefix).toBe('photos/')
    expect(auth.apiInfo.storageApi.allowed.bucketId).toBe(bucketId('bucket-a'))
    expect(auth.apiInfo.storageApi.allowed.bucketName).toBe('bucket-a-name')
  })

  it('normalizes a legacy auth response without allowed info', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: 'account',
          authorizationToken: 'token',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api.example.com',
              downloadUrl: 'https://download.example.com',
              s3ApiUrl: 'https://s3.example.com',
              absoluteMinimumPartSize: 5_000_000,
              recommendedPartSize: 100_000_000,
              capabilities: [],
              bucketId: bucketId('legacy-bucket'),
              bucketName: 'legacy-bucket-name',
              namePrefix: 'legacy/',
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new RawClient({ transport })

    const auth = await raw.authorizeAccount('key-id', 'key-secret', 'https://api.example.com')

    expect(auth.apiInfo.storageApi.allowed.buckets).toEqual([
      { id: bucketId('legacy-bucket'), name: 'legacy-bucket-name' },
    ])
    expect(auth.apiInfo.storageApi.allowed.bucketId).toBe(bucketId('legacy-bucket'))
    expect(auth.apiInfo.storageApi.allowed.namePrefix).toBe('legacy/')
  })

  it('normalizes multi-bucket v4 auth without a legacy single-bucket alias', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: 'account',
          authorizationToken: 'token',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api.example.com',
              downloadUrl: 'https://download.example.com',
              s3ApiUrl: 'https://s3.example.com',
              absoluteMinimumPartSize: 5_000_000,
              recommendedPartSize: 100_000_000,
              allowed: {
                capabilities: [],
                buckets: [
                  { id: bucketId('bucket-a'), name: 'bucket-a-name' },
                  { id: bucketId('bucket-b'), name: 'bucket-b-name' },
                ],
                namePrefix: null,
              },
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new RawClient({ transport })

    const auth = await raw.authorizeAccount('key-id', 'key-secret', 'https://api.example.com')

    expect(auth.apiInfo.storageApi.allowed.buckets).toEqual([
      { id: bucketId('bucket-a'), name: 'bucket-a-name' },
      { id: bucketId('bucket-b'), name: 'bucket-b-name' },
    ])
    expect(auth.apiInfo.storageApi.bucketId).toBeNull()
    expect(auth.apiInfo.storageApi.bucketName).toBeNull()
    expect(auth.apiInfo.storageApi.allowed.bucketId).toBeNull()
    expect(auth.apiInfo.storageApi.allowed.bucketName).toBeNull()
  })

  it('rejects non-absolute realm URLs before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', 'sandbox')).rejects.toThrow(
      B2RealmConfigurationError,
    )
    expect(seenUrls).toEqual([])
  })

  it('rejects unsupported realm URL schemes before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(
      raw.authorizeAccount('key-id', 'key-secret', 'ftp://attacker.example'),
    ).rejects.toThrow('realm URL must use HTTPS or loopback IP HTTP for authorization')
    expect(seenUrls).toEqual([])
  })

  it.each(['https:example.com', 'https:///path'])(
    'rejects malformed realm URL %s before sending credentials',
    async (realmUrl) => {
      const { seenUrls, transport } = recordingTransport()
      const raw = new RawClient({ transport })

      await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
        'realm URL must be an absolute HTTP(S) URL with a hostname for authorization',
      )
      expect(seenUrls).toEqual([])
    },
  )

  it.each([
    'https://user:secret@api.example.com',
    'https://api.example.com?token=query-secret',
    'https://api.example.com#fragment-secret',
  ])(
    'rejects realm URL with non-base components %s before sending credentials',
    async (realmUrl) => {
      const { seenUrls, transport } = recordingTransport()
      const raw = new RawClient({ transport })

      await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
        'realm URL must not include credentials, query, or fragment for authorization',
      )
      expect(seenUrls).toEqual([])
    },
  )
})

describe('RawClient upload URL request controls', () => {
  it('forwards options-bag signal and retry controls to upload URL methods', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const controller = new AbortController()
    const retry = { maxRetries: 2 }

    await raw.getUploadUrl(
      'https://api.example.test',
      'auth',
      { bucketId: bucketId('bucket') },
      { signal: controller.signal, retry },
    )
    await raw.getUploadPartUrl(
      'https://api.example.test',
      'auth',
      { fileId: largeFileId('large-file') },
      { signal: controller.signal, retry },
    )

    expect(seenRequests).toHaveLength(2)
    expect(seenRequests[0]?.signal).toBe(controller.signal)
    expect(seenRequests[0]?.retry).toBe(retry)
    expect(seenRequests[1]?.signal).toBe(controller.signal)
    expect(seenRequests[1]?.retry).toBe(retry)
  })

  it('forwards legacy positional signal and retry controls to upload URL methods', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const controller = new AbortController()
    const retry = { maxRetries: 1 }

    await raw.getUploadUrl(
      'https://api.example.test',
      'auth',
      { bucketId: bucketId('bucket') },
      controller.signal,
      retry,
    )
    await raw.getUploadPartUrl(
      'https://api.example.test',
      'auth',
      { fileId: largeFileId('large-file') },
      controller.signal,
      retry,
    )

    expect(seenRequests).toHaveLength(2)
    expect(seenRequests[0]?.signal).toBe(controller.signal)
    expect(seenRequests[0]?.retry).toBe(retry)
    expect(seenRequests[1]?.signal).toBe(controller.signal)
    expect(seenRequests[1]?.retry).toBe(retry)
  })

  it('forwards options-bag signal and retry controls to raw upload endpoints', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const controller = new AbortController()
    const retry = { maxRetries: 2 }

    await raw.uploadFile(
      'https://upload.example.test/b2_upload_file',
      {
        authorization: 'upload-auth',
        fileName: 'file.txt',
        contentType: 'text/plain',
        contentLength: 1,
        contentSha1: 'none',
      },
      new Uint8Array([1]),
      { signal: controller.signal, retry },
    )
    await raw.uploadPart(
      'https://upload.example.test/b2_upload_part',
      {
        authorization: 'part-auth',
        partNumber: 1,
        contentLength: 1,
        contentSha1: 'none',
      },
      new Uint8Array([1]),
      { signal: controller.signal, retry },
    )

    expect(seenRequests).toHaveLength(2)
    expect(seenRequests[0]?.signal).toBe(controller.signal)
    expect(seenRequests[0]?.retry).toBe(retry)
    expect(seenRequests[1]?.signal).toBe(controller.signal)
    expect(seenRequests[1]?.retry).toBe(retry)
  })

  it('serializes custom upload timestamps for file and large-file starts', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const customUploadTimestamp = 1_700_000_000_000

    await raw.uploadFile(
      'https://upload.example.test/b2_upload_file',
      {
        authorization: 'upload-auth',
        fileName: 'file.txt',
        contentType: 'text/plain',
        contentLength: 1,
        contentSha1: 'none',
        customUploadTimestamp,
      },
      new Uint8Array([1]),
    )
    await raw.startLargeFile('https://api.example.test', 'auth', {
      bucketId: bucketId('bucket'),
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
      customUploadTimestamp: String(customUploadTimestamp),
    })

    expect(seenRequests[0]?.headers?.['X-Bz-Custom-Upload-Timestamp']).toBe(
      String(customUploadTimestamp),
    )
    expect(JSON.parse(String(seenRequests[1]?.body))).toMatchObject({
      customUploadTimestamp: String(customUploadTimestamp),
    })
  })

  it('accepts null custom upload timestamps for raw large-file starts', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()

    await raw.startLargeFile('https://api.example.test', 'auth', {
      bucketId: bucketId('bucket'),
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
      customUploadTimestamp: null,
    })

    expect(JSON.parse(String(seenRequests[0]?.body))).toMatchObject({
      customUploadTimestamp: null,
    })
  })

  it('keeps notification customHeaders in array wire shape', async () => {
    const customHeaders = [
      { name: 'X-B2-Source', value: 'sdk-test' },
      { name: 'X-B2-Rule', value: 'upload-webhook' },
    ] as const
    const rule = {
      eventTypes: [EventType.ObjectCreatedAll],
      isEnabled: true,
      isSuspended: false,
      name: 'upload-webhook',
      objectNamePrefix: '',
      suspensionReason: '',
      targetConfiguration: {
        targetType: 'webhook',
        url: 'https://example.test/webhook',
        customHeaders,
      },
    } as const
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        if (request.url.includes('b2_get_bucket_notification_rules')) {
          return jsonResponse({ bucketId: bucketId('bucket'), eventNotificationRules: [rule] })
        }
        const body = requestJsonBody(request)
        return jsonResponse({
          bucketId: body['bucketId'],
          eventNotificationRules: body['eventNotificationRules'],
        })
      },
    }
    const raw = new RawClient({ transport })

    const setResult = await raw.setBucketNotificationRules('https://api.example.test', 'auth', {
      bucketId: bucketId('bucket'),
      eventNotificationRules: [rule],
    })
    const requestBody = requestJsonBody(seenRequests[0])
    expect(requestBody).toMatchObject({
      eventNotificationRules: [{ targetConfiguration: { customHeaders } }],
    })
    expect(setResult.eventNotificationRules[0]?.targetConfiguration.customHeaders).toEqual(
      customHeaders,
    )

    const getResult = await raw.getBucketNotificationRules('https://api.example.test', 'auth', {
      bucketId: bucketId('bucket'),
    })
    expect(getResult.eventNotificationRules[0]?.targetConfiguration.customHeaders).toEqual(
      customHeaders,
    )
  })

  it('serializes EncryptionKey SSE-C material in JSON body endpoints', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const sourceKey = await EncryptionKey.fromBytes(new Uint8Array(32).fill(1))
    const destinationKey = await EncryptionKey.fromBytes(new Uint8Array(32).fill(2))
    const largeFileKey = await EncryptionKey.fromBytes(new Uint8Array(32).fill(3))

    expect(JSON.stringify(sourceKey)).toContain(SSE_C_KEY_REDACTION)

    await raw.copyFile('https://api.example.test', 'auth', {
      sourceFileId: fileId('4_z_source'),
      fileName: 'copy.bin',
      sourceServerSideEncryption: sourceKey,
      destinationServerSideEncryption: destinationKey,
    })
    await raw.copyPart('https://api.example.test', 'auth', {
      sourceFileId: fileId('4_z_source'),
      largeFileId: fileId('4_z_large'),
      partNumber: 1,
      sourceServerSideEncryption: sourceKey,
      destinationServerSideEncryption: destinationKey,
    })
    await raw.startLargeFile('https://api.example.test', 'auth', {
      bucketId: bucketId('bucket'),
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
      serverSideEncryption: largeFileKey,
    })

    const copyFileBody = requestJsonBody(seenRequests.find((r) => r.url.includes('b2_copy_file')))
    const copyPartBody = requestJsonBody(seenRequests.find((r) => r.url.includes('b2_copy_part')))
    const startBody = requestJsonBody(
      seenRequests.find((r) => r.url.includes('b2_start_large_file')),
    )

    expect(copyFileBody['sourceServerSideEncryption']).toEqual(wireSseC(sourceKey))
    expect(copyFileBody['destinationServerSideEncryption']).toEqual(wireSseC(destinationKey))
    expect(copyPartBody['sourceServerSideEncryption']).toEqual(wireSseC(sourceKey))
    expect(copyPartBody['destinationServerSideEncryption']).toEqual(wireSseC(destinationKey))
    expect(startBody['serverSideEncryption']).toEqual(wireSseC(largeFileKey))
    expect(JSON.stringify([copyFileBody, copyPartBody, startBody])).not.toContain(
      SSE_C_KEY_REDACTION,
    )
  })

  it('keeps EncryptionKey SSE-C material out of diagnostics on JSON body failures', async () => {
    const key = await EncryptionKey.fromBytes(new Uint8Array(32).fill(4))
    const wireBodies: string[] = []
    const diagnostics: unknown[] = []
    const errors: string[] = []
    const transport: HttpTransport = {
      async send(request: HttpRequest): Promise<HttpResponse> {
        wireBodies.push(String(request.body))
        diagnostics.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
        })
        return {
          status: 500,
          headers: new Headers(),
          body: null,
          json: async () => {
            throw new Error(`forced JSON failure for ${request.url}`)
          },
          text: () => Promise.resolve('forced failure'),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }
      },
    }
    const raw = new RawClient({ transport })

    for (const call of [
      () =>
        raw.copyFile('https://api.example.test', 'auth', {
          sourceFileId: fileId('4_z_source'),
          fileName: 'copy.bin',
          sourceServerSideEncryption: key,
          destinationServerSideEncryption: key,
        }),
      () =>
        raw.copyPart('https://api.example.test', 'auth', {
          sourceFileId: fileId('4_z_source'),
          largeFileId: fileId('4_z_large'),
          partNumber: 1,
          sourceServerSideEncryption: key,
          destinationServerSideEncryption: key,
        }),
      () =>
        raw.startLargeFile('https://api.example.test', 'auth', {
          bucketId: bucketId('bucket'),
          fileName: 'large.bin',
          contentType: 'application/octet-stream',
          serverSideEncryption: key,
        }),
    ]) {
      try {
        await call()
      } catch (err) {
        errors.push(String(err instanceof Error ? `${err.name}: ${err.message}` : err))
      }
    }

    expect(errors).toHaveLength(3)
    const diagnosticSurfaces = JSON.stringify({ diagnostics, errors })
    expect(diagnosticSurfaces).not.toContain(key.customerKey)
    expect(diagnosticSurfaces).not.toContain(key.customerKeyMd5)

    const intendedWireBodies = wireBodies.join('\n')
    expect(intendedWireBodies).toContain(key.customerKey)
    expect(intendedWireBodies).toContain(key.customerKeyMd5)
    expect(intendedWireBodies).not.toContain(SSE_C_KEY_REDACTION)
  })

  it('rejects invalid custom upload timestamps before transport serialization', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const invalidHeaderValues = [
      -1,
      12.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      '1\r\nX-Injected: yes' as unknown as number,
    ]
    const invalidLargeFileValues = [
      '-1',
      '12.5',
      String(Number.MAX_SAFE_INTEGER + 1),
      'NaN',
      '1\r\nX-Injected: yes',
      1_700_000_000_000 as unknown as string,
    ]

    for (const customUploadTimestamp of invalidHeaderValues) {
      await expect(
        raw.uploadFile(
          'https://upload.example.test/b2_upload_file',
          {
            authorization: 'upload-auth',
            fileName: 'file.txt',
            contentType: 'text/plain',
            contentLength: 1,
            contentSha1: 'none',
            customUploadTimestamp,
          },
          new Uint8Array([1]),
        ),
      ).rejects.toThrow('customUploadTimestamp must be a non-negative safe integer')
    }

    for (const customUploadTimestamp of invalidLargeFileValues) {
      await expect(
        raw.startLargeFile('https://api.example.test', 'auth', {
          bucketId: bucketId('bucket'),
          fileName: 'large.bin',
          contentType: 'application/octet-stream',
          customUploadTimestamp,
        }),
      ).rejects.toThrow('customUploadTimestamp must be a non-negative safe integer string or null')
    }

    expect(seenRequests).toHaveLength(0)
  })

  it('forwards legacy positional signal and retry controls to raw upload endpoints', async () => {
    const { raw, seenRequests } = makeUploadUrlRawClient()
    const controller = new AbortController()
    const retry = { maxRetries: 1 }

    await raw.uploadFile(
      'https://upload.example.test/b2_upload_file',
      {
        authorization: 'upload-auth',
        fileName: 'file.txt',
        contentType: 'text/plain',
        contentLength: 1,
        contentSha1: 'none',
      },
      new Uint8Array([1]),
      controller.signal,
      retry,
    )
    await raw.uploadPart(
      'https://upload.example.test/b2_upload_part',
      {
        authorization: 'part-auth',
        partNumber: 1,
        contentLength: 1,
        contentSha1: 'none',
      },
      new Uint8Array([1]),
      controller.signal,
      retry,
    )

    expect(seenRequests).toHaveLength(2)
    expect(seenRequests[0]?.signal).toBe(controller.signal)
    expect(seenRequests[0]?.retry).toBe(retry)
    expect(seenRequests[1]?.signal).toBe(controller.signal)
    expect(seenRequests[1]?.retry).toBe(retry)
  })
})

describe('RawClient URL construction', () => {
  it('preserves storage endpoint paths through the shared URL builder', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        if (request.url.includes('b2_download_file_by_id')) {
          return {
            status: 200,
            headers: new Headers(),
            body: null,
            json: <T>() => Promise.resolve({} as T),
            text: () => Promise.resolve(''),
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          }
        }
        if (request.url.includes('b2_finish_large_file')) {
          return jsonResponse({ contentSha1: 'none' })
        }
        if (request.url.includes('b2_create_key')) {
          return jsonResponse({ bucketIds: null })
        }
        return jsonResponse({})
      },
    }
    const raw = new RawClient({ transport })

    await raw.listBuckets('https://api.example.test', 'auth', { accountId: 'account' as never })
    await raw.finishLargeFile('https://api.example.test', 'auth', {
      fileId: largeFileId('large-file'),
      partSha1Array: [],
    })
    await raw.downloadFileById('https://download.example.test', 'auth', fileId('4_z_file'))
    await raw.createKey('https://api.example.test', 'auth', {
      accountId: 'account' as never,
      capabilities: [],
      keyName: 'key',
    })

    expect(seenRequests.map((request) => request.url)).toEqual([
      'https://api.example.test/b2api/v3/b2_list_buckets',
      'https://api.example.test/b2api/v3/b2_finish_large_file',
      'https://download.example.test/b2api/v3/b2_download_file_by_id?fileId=4_z_file',
      'https://api.example.test/b2api/v4/b2_create_key',
    ])
  })
})

function makeUploadUrlRawClient(): { raw: RawClient; seenRequests: HttpRequest[] } {
  const seenRequests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request: HttpRequest): Promise<HttpResponse> {
      seenRequests.push(request)
      if (request.url.includes('b2_copy_part')) {
        return jsonResponse({
          fileId: fileId('4_z_large'),
          partNumber: 1,
          contentLength: 1,
          contentSha1: 'none',
          contentMd5: null,
        })
      }
      if (request.url.includes('b2_copy_file')) {
        return jsonResponse({
          fileId: fileId('4_z_copy'),
          fileName: 'copy.bin',
          action: 'copy',
          contentLength: 1,
          contentSha1: 'none',
        })
      }
      if (request.url.includes('b2_upload_part')) {
        return jsonResponse({
          fileId: largeFileId('large-file'),
          partNumber: 1,
          contentLength: 1,
          contentSha1: 'none',
        })
      }
      if (request.url.includes('b2_upload_file')) {
        return jsonResponse({
          fileId: fileId('4_z_file'),
          fileName: 'file.txt',
          action: 'upload',
          contentLength: 1,
          contentSha1: 'none',
        })
      }
      if (request.url.includes('b2_get_upload_part_url')) {
        return jsonResponse({
          fileId: largeFileId('large-file'),
          uploadUrl: 'https://upload.example.test/part',
          authorizationToken: 'part-auth',
        })
      }
      if (request.url.includes('b2_start_large_file')) {
        return jsonResponse({
          fileId: largeFileId('large-file'),
          fileName: 'large.bin',
          accountId: 'account',
          bucketId: bucketId('bucket'),
          contentType: 'application/octet-stream',
          fileInfo: {},
          uploadTimestamp: 1_700_000_000_000,
        })
      }
      return jsonResponse({
        bucketId: bucketId('bucket'),
        uploadUrl: 'https://upload.example.test/file',
        authorizationToken: 'file-auth',
      })
    },
  }
  return { raw: new RawClient({ transport }), seenRequests }
}

function requestJsonBody(request: HttpRequest | undefined): Record<string, unknown> {
  expect(request).toBeDefined()
  expect(typeof request?.body).toBe('string')
  return JSON.parse(String(request?.body)) as Record<string, unknown>
}

function wireSseC(key: EncryptionKey): Record<string, string> {
  return {
    mode: EncryptionMode.SseC,
    algorithm: EncryptionAlgorithm.Aes256,
    customerKey: key.customerKey,
    customerKeyMd5: key.customerKeyMd5,
  }
}
