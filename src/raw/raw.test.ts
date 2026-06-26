import { describe, expect, it } from 'vitest'
import { B2RealmConfigurationError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import { bucketId, fileId, largeFileId } from '../types/ids.ts'
import { RawClient } from './index.ts'

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

  it.each([
    'https:example.com',
    'https:///path',
  ])('rejects malformed realm URL %s before sending credentials', async (realmUrl) => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
      'realm URL must be an absolute HTTP(S) URL with a hostname for authorization',
    )
    expect(seenUrls).toEqual([])
  })

  it.each([
    'https://user:secret@api.example.com',
    'https://api.example.com?token=query-secret',
    'https://api.example.com#fragment-secret',
  ])('rejects realm URL with non-base components %s before sending credentials', async (realmUrl) => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
      'realm URL must not include credentials, query, or fragment for authorization',
    )
    expect(seenUrls).toEqual([])
  })
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

function makeUploadUrlRawClient(): { raw: RawClient; seenRequests: HttpRequest[] } {
  const seenRequests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request: HttpRequest): Promise<HttpResponse> {
      seenRequests.push(request)
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
      return jsonResponse({
        bucketId: bucketId('bucket'),
        uploadUrl: 'https://upload.example.test/file',
        authorizationToken: 'file-auth',
      })
    },
  }
  return { raw: new RawClient({ transport }), seenRequests }
}
