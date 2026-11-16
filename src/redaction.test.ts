import { describe, expect, it } from 'vitest'
import type { AccountInfo } from './auth/account-info.ts'
import { UploadUrlPool } from './auth/index.ts'
import { BackupClient } from './backup/index.ts'
import { DEFAULT_RETRY_OPTIONS } from './http/retry.ts'
import {
  authorizeAccountResponseForPersistence,
  B2Client,
  B2Object,
  Bucket,
  downloadAuthorizationResponseForPersistence,
  getUploadPartUrlResponseForPersistence,
  getUploadUrlResponseForPersistence,
  InMemoryAccountInfo,
} from './index.ts'
import { InMemoryPartnerAccountInfo, PartnerClient } from './partner/index.ts'
import { APPLICATION_KEY_REDACTED } from './partner/redaction-placeholders.ts'
import { getUploadPartUrlResponseForPersistence as rawPartUrlForPersistence } from './raw/index.ts'
import {
  redactAuthorizeAccountResponse,
  redactDownloadAuthorizationResponse,
  redactGetUploadPartUrlResponse,
  redactGetUploadUrlResponse,
} from './response-redaction.ts'
import { B2Simulator } from './simulator/index.ts'
import { jsonResponse } from './test-utils/index.ts'
import type { AuthorizeAccountResponse } from './types/auth.ts'
import { type BucketInfo, BucketType } from './types/bucket.ts'
import { type AuthToken, bucketId, largeFileId, partnerToken } from './types/ids.ts'

const APP_KEY = 'SECRET-APPKEY'
const ACCOUNT_TOKEN = 'SECRET-ACCOUNT-TOKEN'
const UPLOAD_TOKEN = 'SECRET-UPLOAD-TOKEN'
const PART_TOKEN = 'SECRET-PART-UPLOAD-TOKEN'
const DOWNLOAD_TOKEN = 'SECRET-DOWNLOAD-TOKEN'
const SECRETS = [APP_KEY, ACCOUNT_TOKEN, UPLOAD_TOKEN, PART_TOKEN, DOWNLOAD_TOKEN]
const BID = bucketId('diagnostic-bucket-id')
const entry = { uploadUrl: 'https://pod.backblaze.com/upload', authorizationToken: UPLOAD_TOKEN }

async function fixture() {
  const sim = new B2Simulator()
  const seed = new B2Client({
    applicationKeyId: 'key-id',
    applicationKey: APP_KEY,
    transport: sim.transport(),
  })
  const auth: AuthorizeAccountResponse = {
    ...(await seed.authorize()),
    authorizationToken: ACCOUNT_TOKEN as AuthToken,
  }
  const info: BucketInfo = (
    await seed.createBucket({
      bucketName: 'diagnostic-bucket',
      bucketType: BucketType.AllPrivate,
    })
  ).info
  const store = new InMemoryAccountInfo()
  const client = new B2Client({
    applicationKeyId: 'key-id',
    applicationKey: APP_KEY,
    accountInfo: store,
    transport: {
      async send(request) {
        if (request.url.includes('b2_get_upload_part_url')) {
          return jsonResponse({
            fileId: largeFileId('diagnostic-large-file-id'),
            uploadUrl: entry.uploadUrl,
            authorizationToken: PART_TOKEN,
          })
        }
        if (request.url.includes('b2_get_upload_url')) {
          return jsonResponse({
            bucketId: BID,
            uploadUrl: entry.uploadUrl,
            authorizationToken: UPLOAD_TOKEN,
          })
        }
        if (request.url.includes('b2_get_download_authorization')) {
          return jsonResponse({
            bucketId: BID,
            fileNamePrefix: 'diagnostic',
            authorizationToken: DOWNLOAD_TOKEN,
          })
        }
        return jsonResponse(auth)
      },
    },
  })
  const bucket = new Bucket(client, info, DEFAULT_RETRY_OPTIONS)
  return { auth, store, client, bucket, object: bucket.file('diagnostic.txt') }
}

function assertNoSecrets(rendered: string): void {
  for (const secret of SECRETS) expect(rendered).not.toContain(secret)
}

function poolTokens(store: AccountInfo): void {
  store.returnUploadUrl(BID, entry)
  store.returnPartUploadUrl('large-file-id', { ...entry, authorizationToken: PART_TOKEN })
}

async function returnedResponses() {
  const { client, store, bucket } = await fixture()
  const authorize = await client.authorize()
  const upload = await client.raw.getUploadUrl(store.getApiUrl(), store.getAuthToken(), {
    bucketId: BID,
  })
  const part = await client.raw.getUploadPartUrl(store.getApiUrl(), store.getAuthToken(), {
    fileId: largeFileId('diagnostic-large-file-id'),
  })
  const download = await bucket.getDownloadAuthorization('diagnostic', 60)
  return { authorize, upload, part, download }
}

function hideResponseData(response: object, accessor = true): void {
  for (const key of Object.keys(response)) {
    const value: unknown = Reflect.get(response, key)
    Object.defineProperty(response, key, {
      ...(accessor ? { get: () => value } : { value }),
      enumerable: false,
      configurable: true,
    })
  }
}

describe('credential redaction JSON and spread', () => {
  it.each(['data', 'accessor'])(
    'setAuth preserves non-enumerable authorization %s fields',
    async (kind) => {
      const { authorize } = await returnedResponses()
      const expected = {
        accountId: authorize.accountId,
        authorizationToken: authorize.authorizationToken,
        apiInfo: authorize.apiInfo,
        applicationKeyExpirationTimestamp: authorize.applicationKeyExpirationTimestamp,
      }
      hideResponseData(authorize, kind === 'accessor')
      const store = new InMemoryAccountInfo()
      store.setAuth(authorize)
      expect(store.getApiUrl()).toBe(expected.apiInfo.storageApi.apiUrl)
      expect(store.getDownloadUrl()).toBe(expected.apiInfo.storageApi.downloadUrl)
      expect(store.getS3ApiUrl()).toBe(expected.apiInfo.storageApi.s3ApiUrl)
      expect(store.getRecommendedPartSize()).toBe(expected.apiInfo.storageApi.recommendedPartSize)
      expect(store.getAbsoluteMinimumPartSize()).toBe(
        expected.apiInfo.storageApi.absoluteMinimumPartSize,
      )
      expect(store.getAccountId()).toBe(expected.accountId)
      expect(store.getAuthToken()).toBe(expected.authorizationToken)
      expect(store.getAuth()).toEqual(expected)
      expect(JSON.parse(JSON.stringify(store.getAuth()))).toEqual(expected)
      expect(Object.getOwnPropertyDescriptor(store.getAuth(), 'apiInfo')).toMatchObject({
        value: expected.apiInfo,
        enumerable: true,
      })
      expect(JSON.stringify(authorize)).not.toContain(ACCOUNT_TOKEN)
    },
  )

  it.each(['authorize', 'upload', 'part', 'download'] as const)(
    '%s persistence retains non-enumerable response data',
    async (name) => {
      const responses = await returnedResponses()
      const expected = {
        authorize: {
          accountId: responses.authorize.accountId,
          authorizationToken: ACCOUNT_TOKEN,
          apiInfo: responses.authorize.apiInfo,
          applicationKeyExpirationTimestamp: responses.authorize.applicationKeyExpirationTimestamp,
        },
        upload: { bucketId: BID, uploadUrl: entry.uploadUrl, authorizationToken: UPLOAD_TOKEN },
        part: {
          fileId: largeFileId('diagnostic-large-file-id'),
          uploadUrl: entry.uploadUrl,
          authorizationToken: PART_TOKEN,
        },
        download: {
          bucketId: BID,
          fileNamePrefix: 'diagnostic',
          authorizationToken: DOWNLOAD_TOKEN,
        },
      }
      const persist = {
        authorize: () => authorizeAccountResponseForPersistence(responses.authorize),
        upload: () => getUploadUrlResponseForPersistence(responses.upload),
        part: () => getUploadPartUrlResponseForPersistence(responses.part),
        download: () => downloadAuthorizationResponseForPersistence(responses.download),
      }
      hideResponseData(responses[name])
      const copy = persist[name]()
      expect(copy).toEqual(expected[name])
      expect(JSON.parse(JSON.stringify(copy))).toEqual(expected[name])
      expect(Object.hasOwn(copy, 'toJSON')).toBe(false)
      expect(Object.hasOwn(copy, Symbol.for('nodejs.util.inspect.custom'))).toBe(false)
    },
  )

  it('frozen response accessors retain all data after redaction', () => {
    const expected = {
      fileId: largeFileId('diagnostic-large-file-id'),
      uploadUrl: entry.uploadUrl,
      authorizationToken: PART_TOKEN,
    }
    const original = { ...expected }
    hideResponseData(original)
    Object.freeze(original)
    const response = redactGetUploadPartUrlResponse(original)
    expect(response.fileId).toBe(expected.fileId)
    expect(response.uploadUrl).toBe(expected.uploadUrl)
    expect(response.authorizationToken).toBe(expected.authorizationToken)
    expect(getUploadPartUrlResponseForPersistence(response)).toEqual(expected)
    expect(Object.keys(response)).not.toContain('authorizationToken')
    expect(JSON.stringify(response)).not.toContain(PART_TOKEN)
  })

  it.each(['authorize', 'upload', 'part', 'download'] as const)(
    '%s response excludes its token from enumeration',
    async (name) => {
      const response = (await returnedResponses())[name]
      const token = response.authorizationToken
      const spread = { ...response }
      const entries = Object.entries(response)
      const browserPreview: Record<string, unknown> = {}
      for (const key in response) browserPreview[key] = Reflect.get(response, key)
      expect(spread).not.toHaveProperty('authorizationToken')
      expect(entries.map(([key]) => key)).not.toContain('authorizationToken')
      expect(browserPreview).not.toHaveProperty('authorizationToken')
      for (const surface of [spread, entries, browserPreview, response]) {
        expect(JSON.stringify(surface)).not.toContain(token)
      }
      expect(String(response)).not.toContain(token)
      const descriptor = Object.getOwnPropertyDescriptor(response, 'authorizationToken')
      expect(descriptor?.enumerable).toBe(false)
      expect(descriptor?.get).toBeTypeOf('function')
      expect(descriptor).not.toHaveProperty('value')
      expect(response.authorizationToken).toBe(token)
    },
  )

  it('persistence accepts ordinary token values matching the diagnostic label', async () => {
    const { auth } = await fixture()
    const token = '[redacted authorization token]'
    const authorize = { ...auth, authorizationToken: token as AuthToken }
    const upload = { bucketId: BID, ...entry, authorizationToken: token }
    const part = {
      fileId: largeFileId('diagnostic-large-file-id'),
      ...entry,
      authorizationToken: token,
    }
    const download = { bucketId: BID, fileNamePrefix: 'diagnostic', authorizationToken: token }
    expect(authorizeAccountResponseForPersistence(authorize).authorizationToken).toBe(token)
    expect(getUploadUrlResponseForPersistence(upload).authorizationToken).toBe(token)
    expect(getUploadPartUrlResponseForPersistence(part).authorizationToken).toBe(token)
    expect(downloadAuthorizationResponseForPersistence(download).authorizationToken).toBe(token)
    expect(
      authorizeAccountResponseForPersistence(redactAuthorizeAccountResponse(authorize))
        .authorizationToken,
    ).toBe(token)
    expect(
      getUploadUrlResponseForPersistence(redactGetUploadUrlResponse(upload)).authorizationToken,
    ).toBe(token)
    expect(
      getUploadPartUrlResponseForPersistence(redactGetUploadPartUrlResponse(part))
        .authorizationToken,
    ).toBe(token)
    expect(
      downloadAuthorizationResponseForPersistence(redactDownloadAuthorizationResponse(download))
        .authorizationToken,
    ).toBe(token)
    const store = new InMemoryAccountInfo()
    store.setAuth({ ...auth, authorizationToken: token as AuthToken })
    expect(store.getAuthToken()).toBe(token)
  })

  it('persistence rejects diagnostic provenance independently of the token text', async () => {
    const { authorize, upload, part, download } = await returnedResponses()
    for (const [response, helper] of [
      [authorize, authorizeAccountResponseForPersistence],
      [upload, getUploadUrlResponseForPersistence],
      [part, getUploadPartUrlResponseForPersistence],
      [download, downloadAuthorizationResponseForPersistence],
    ] as const) {
      const rebuilt = JSON.parse(JSON.stringify(response))
      expect(rebuilt._b2sdkDiagnostic).toBe('authorization-token-redacted')
      rebuilt.authorizationToken = 'diagnostic replacement'
      expect(() => helper(rebuilt)).toThrow(TypeError)
    }
  })

  it('frozen response data keeps direct token access without enumeration', async () => {
    const original = Object.freeze({
      fileId: largeFileId('diagnostic-large-file-id'),
      ...entry,
      authorizationToken: PART_TOKEN,
    })
    const response = redactGetUploadPartUrlResponse(original)
    expect(Object.isFrozen(original)).toBe(true)
    expect(response).not.toBe(original)
    expect(Object.keys(response)).not.toContain('authorizationToken')
    expect(JSON.stringify(response)).not.toContain(PART_TOKEN)
    expect(response.authorizationToken).toBe(PART_TOKEN)
    expect(getUploadPartUrlResponseForPersistence(response).authorizationToken).toBe(PART_TOKEN)
  })

  it('persistence helpers and memory stores reject incomplete response copies', async () => {
    const { authorize, upload, part, download } = await returnedResponses()
    expect(() => authorizeAccountResponseForPersistence({ ...authorize })).toThrow(TypeError)
    expect(() => getUploadUrlResponseForPersistence({ ...upload })).toThrow(TypeError)
    expect(() => getUploadPartUrlResponseForPersistence({ ...part })).toThrow(TypeError)
    expect(() => downloadAuthorizationResponseForPersistence({ ...download })).toThrow(TypeError)
    const store = new InMemoryAccountInfo()
    expect(() => store.setAuth({ ...authorize })).toThrow(TypeError)
    expect(store.getAuth()).toBeNull()
  })

  it('persistence copies omit an enumerable JSON hook', async () => {
    const { auth } = await fixture()
    const response = { ...auth, toJSON: () => ({ authorized: true }) }
    const copy = authorizeAccountResponseForPersistence(response)
    expect(Object.hasOwn(copy, 'toJSON')).toBe(false)
    expect(JSON.parse(JSON.stringify(copy)).authorizationToken).toBe(ACCOUNT_TOKEN)
    const store = new InMemoryAccountInfo()
    store.setAuth(response)
    expect(store.getAuth()).not.toHaveProperty('toJSON')
    expect(JSON.parse(JSON.stringify(store.getAuth())).authorizationToken).toBe(ACCOUNT_TOKEN)
  })

  it.each(['number', 'getter'] as const)(
    'setAuth rejects a non-string token from an enumerable %s property',
    async (kind) => {
      const { auth } = await fixture()
      Object.defineProperty(
        auth,
        'authorizationToken',
        kind === 'number'
          ? { value: 12345, enumerable: true }
          : { get: () => undefined, enumerable: true },
      )
      const store = new InMemoryAccountInfo()
      expect(() => store.setAuth(auth)).toThrow(TypeError)
      expect(store.getAuth()).toBeNull()
    },
  )

  it('fixed token descriptors retain direct access without enumeration', () => {
    const original = {
      fileId: largeFileId('diagnostic-large-file-id'),
      ...entry,
      authorizationToken: PART_TOKEN,
    }
    Object.defineProperty(original, 'authorizationToken', { configurable: false })
    expect(Object.isExtensible(original)).toBe(true)
    const response = redactGetUploadPartUrlResponse(original)
    expect(response).not.toBe(original)
    expect(Object.keys(response)).not.toContain('authorizationToken')
    expect(response.authorizationToken).toBe(PART_TOKEN)
    expect(getUploadPartUrlResponseForPersistence(response).authorizationToken).toBe(PART_TOKEN)
  })

  it('client summary isolates a custom enumerable AccountInfo', async () => {
    const { auth } = await fixture()
    const store = {
      auth,
      getAuth() {
        return auth
      },
    } as unknown as AccountInfo
    const client = new B2Client({
      applicationKeyId: 'key-id',
      applicationKey: APP_KEY,
      accountInfo: store,
    })

    assertNoSecrets(JSON.stringify(client))
    expect(JSON.parse(JSON.stringify(client))).toEqual({
      type: 'B2Client',
      applicationKeyId: 'key-id',
      credentials: APPLICATION_KEY_REDACTED,
      realm: 'https://api.backblazeb2.com/',
      authorized: true,
      urlGuardAllowedSuffixes: ['backblaze.com', 'backblazeb2.com'],
    })
  })

  it('client spread isolates a custom enumerable AccountInfo', async () => {
    const { auth } = await fixture()
    const store = {
      auth,
      getAuth() {
        return auth
      },
    } as unknown as AccountInfo
    const client = new B2Client({
      applicationKeyId: 'key-id',
      applicationKey: APP_KEY,
      accountInfo: store,
    })
    assertNoSecrets(JSON.stringify({ ...client }))
    expect(client.accountInfo).toBe(store)
  })

  it('accountInfo is a public getter with deliberate copy and assignment behavior', async () => {
    const { client, store } = await fixture()
    expect(Object.hasOwn(client, 'accountInfo')).toBe(false)
    expect(Object.getOwnPropertyDescriptor(client, 'accountInfo')).toBeUndefined()
    expect(Object.keys(client)).not.toContain('accountInfo')
    expect({ ...client }).not.toHaveProperty('accountInfo')
    expect(Object.assign({}, client)).not.toHaveProperty('accountInfo')
    expect('accountInfo' in client).toBe(true)
    expect(client.accountInfo).toBe(store)
    // ES modules are strict; the cast only bypasses the readonly type check.
    expect(() => {
      const writable = client as unknown as { accountInfo: AccountInfo }
      writable.accountInfo = new InMemoryAccountInfo()
    }).toThrow(TypeError)
    expect(client.accountInfo).toBe(store)
  })

  it('client summary redacts realm userinfo and query', () => {
    const client = new B2Client({
      applicationKeyId: 'key-id',
      applicationKey: APP_KEY,
      realm:
        'https://realm-user:realm-password@example.com/private?token=realm-query#realm-fragment',
    })
    const summary = JSON.parse(JSON.stringify(client)) as { realm: string; authorized: boolean }
    expect(summary.realm).toBe('https://example.com/...')
    expect(summary.authorized).toBe(false)
    for (const secret of ['realm-user', 'realm-password', 'realm-query', 'realm-fragment']) {
      expect(JSON.stringify(client)).not.toContain(secret)
    }
  })

  it('client field is hidden from spread and Object.keys', async () => {
    const { client } = await fixture()
    expect(Object.keys(client)).not.toContain('applicationKey')
    assertNoSecrets(JSON.stringify({ ...client }))
  })

  it('memory store fields are hidden from spread', async () => {
    const { auth, store } = await fixture()
    store.setAuth(auth)
    poolTokens(store)
    expect(Object.keys(store)).not.toContain('auth')
    expect(Object.keys(store)).not.toContain('uploadUrls')
    expect(Object.keys(store)).not.toContain('partUploadUrls')
    assertNoSecrets(JSON.stringify({ ...store }))
  })

  it('memory store JSON preserves a safe authorized summary', async () => {
    const { auth, store } = await fixture()
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: false })
    store.setAuth(auth)
    poolTokens(store)
    assertNoSecrets(JSON.stringify(store))
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: true })
    store.clear()
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: false })
  })

  it.each(['bucket', 'object'] as const)(
    '%s client reference is hidden from Object.keys and spread',
    async (name) => {
      const value = await fixture()
      await value.client.authorize()
      poolTokens(value.store)
      const handle = value[name]
      expect(Object.keys(handle)).not.toContain('client')
      assertNoSecrets(JSON.stringify({ ...handle }))
      expect(value.bucket.name).toBe('diagnostic-bucket')
      expect(value.object.fileName).toBe('diagnostic.txt')
    },
  )

  it('direct pool entries are hidden from spread', () => {
    const pool = new UploadUrlPool()
    pool.checkin('bucket', entry)
    expect(Object.keys({ ...pool })).toEqual([])
    assertNoSecrets(JSON.stringify(pool))
    assertNoSecrets(JSON.stringify({ ...pool }))
    expect(pool.checkout('bucket')).toBe(entry)
  })

  it('getAuth and authorize retain the full token response', async () => {
    const { client, store } = await fixture()
    const response = await client.authorize()
    expect(response.authorizationToken).toBe(ACCOUNT_TOKEN)
    expect(store.getAuth()?.authorizationToken).toBe(ACCOUNT_TOKEN)
    expect(JSON.parse(JSON.stringify(response)).authorizationToken).toBe(
      '[redacted authorization token]',
    )
    expect(JSON.parse(JSON.stringify(store.getAuth())).authorizationToken).toBe(ACCOUNT_TOKEN)
    expect(client.accountInfo).toBe(store)
    poolTokens(store)
    expect(store.checkoutUploadUrl(BID)?.authorizationToken).toBe(UPLOAD_TOKEN)
    expect(store.checkoutPartUploadUrl('large-file-id')?.authorizationToken).toBe(PART_TOKEN)
  })

  it('authorize response redacts diagnostic JSON and String while retaining its token', async () => {
    const { client } = await fixture()
    const response = await client.authorize()
    expect(response.authorizationToken).toBe(ACCOUNT_TOKEN)
    expect(JSON.stringify(response)).not.toContain(ACCOUNT_TOKEN)
    expect(String(response)).not.toContain(ACCOUNT_TOKEN)
  })

  it('upload URL response redacts diagnostic JSON and String while retaining its token', async () => {
    const { client, store } = await fixture()
    await client.authorize()
    const response = await client.raw.getUploadUrl(store.getApiUrl(), store.getAuthToken(), {
      bucketId: BID,
    })
    expect(response.authorizationToken).toBe(UPLOAD_TOKEN)
    expect(JSON.stringify(response)).not.toContain(UPLOAD_TOKEN)
    expect(String(response)).not.toContain(UPLOAD_TOKEN)
  })

  it('download authorization response redacts diagnostic JSON and String while retaining its token', async () => {
    const { client, bucket } = await fixture()
    await client.authorize()
    const response = await bucket.getDownloadAuthorization('diagnostic', 60)
    expect(response.authorizationToken).toBe(DOWNLOAD_TOKEN)
    expect(JSON.stringify(response)).not.toContain(DOWNLOAD_TOKEN)
    expect(String(response)).not.toContain(DOWNLOAD_TOKEN)
  })

  it('part upload URL response redacts diagnostic JSON and String while retaining its token', async () => {
    const { client, store } = await fixture()
    await client.authorize()
    const response = await client.raw.getUploadPartUrl(store.getApiUrl(), store.getAuthToken(), {
      fileId: largeFileId('diagnostic-large-file-id'),
    })
    expect(response.authorizationToken).toBe(PART_TOKEN)
    expect(JSON.stringify(response)).not.toContain(PART_TOKEN)
    expect(String(response)).not.toContain(PART_TOKEN)
  })

  it('part upload URL persistence preserves the real token and rejects diagnostic JSON', async () => {
    const { client, store } = await fixture()
    await client.authorize()
    const response = await client.raw.getUploadPartUrl(store.getApiUrl(), store.getAuthToken(), {
      fileId: largeFileId('diagnostic-large-file-id'),
    })
    expect(rawPartUrlForPersistence).toBe(getUploadPartUrlResponseForPersistence)
    const copy = getUploadPartUrlResponseForPersistence(response)
    expect(copy).not.toBe(response)
    expect(copy).toEqual({ ...response, authorizationToken: PART_TOKEN })
    expect(Object.keys(copy).filter((key) => key !== 'authorizationToken')).toEqual(
      Object.keys(response),
    )
    expect(Object.getOwnPropertyDescriptor(response, 'toJSON')?.enumerable).toBe(false)
    expect(
      Object.getOwnPropertyDescriptor(response, Symbol.for('nodejs.util.inspect.custom'))
        ?.enumerable,
    ).toBe(false)
    expect(Object.getOwnPropertyDescriptor(copy, 'toJSON')).toBeUndefined()
    expect(
      Object.getOwnPropertyDescriptor(copy, Symbol.for('nodejs.util.inspect.custom')),
    ).toBeUndefined()
    const reloaded = JSON.parse(JSON.stringify(copy))
    expect(reloaded.authorizationToken).toBe(PART_TOKEN)
    store.returnPartUploadUrl(response.fileId, reloaded)
    expect(store.checkoutPartUploadUrl(response.fileId)?.authorizationToken).toBe(PART_TOKEN)
    const diagnostic = JSON.parse(JSON.stringify(response))
    expect(() => getUploadPartUrlResponseForPersistence(diagnostic)).toThrow(TypeError)
    expect(() => getUploadPartUrlResponseForPersistence(diagnostic)).toThrow(
      'getUploadPartUrlResponseForPersistence',
    )
    expect(
      getUploadPartUrlResponseForPersistence({
        ...response,
        authorizationToken: '[redacted authorization token]',
      }).authorizationToken,
    ).toBe('[redacted authorization token]')
  })

  it('plain persistence copies retain all three real tokens', async () => {
    const { client, bucket, store } = await fixture()
    const auth = await client.authorize()
    const upload = await client.raw.getUploadUrl(store.getApiUrl(), store.getAuthToken(), {
      bucketId: BID,
    })
    const download = await bucket.getDownloadAuthorization('diagnostic', 60)
    for (const [response, copy] of [
      [auth, authorizeAccountResponseForPersistence(auth)],
      [upload, getUploadUrlResponseForPersistence(upload)],
      [download, downloadAuthorizationResponseForPersistence(download)],
    ] as const) {
      expect(copy.authorizationToken).toBe(response.authorizationToken)
      expect(JSON.parse(JSON.stringify(copy)).authorizationToken).toBe(response.authorizationToken)
      expect(Object.keys(copy).filter((key) => key !== 'authorizationToken')).toEqual(
        Object.keys(response),
      )
      expect(Object.hasOwn(response, 'toJSON')).toBe(true)
      expect(Object.keys(response)).not.toContain('toJSON')
    }
  })

  it('persistence helpers reject diagnostic JSON as input', async () => {
    const { client, bucket, store } = await fixture()
    const auth = await client.authorize()
    const upload = await client.raw.getUploadUrl(store.getApiUrl(), store.getAuthToken(), {
      bucketId: BID,
    })
    const download = await bucket.getDownloadAuthorization('diagnostic', 60)
    for (const [response, helper] of [
      [auth, authorizeAccountResponseForPersistence],
      [upload, getUploadUrlResponseForPersistence],
      [download, downloadAuthorizationResponseForPersistence],
    ] as const) {
      const rebuilt = JSON.parse(JSON.stringify(response))
      expect(() => helper(rebuilt)).toThrow(TypeError)
    }
  })

  it('account stores reject diagnostic JSON instead of caching its placeholder', async () => {
    const { client } = await fixture()
    const response = await client.authorize()
    const rebuilt = JSON.parse(JSON.stringify(response)) as AuthorizeAccountResponse
    const store = new InMemoryAccountInfo()
    expect(() => store.setAuth(rebuilt)).toThrow(TypeError)
    expect(store.getAuth()).toBeNull()
  })

  it('Bun-style inherited JSON hook redacts a returned response', async () => {
    const simulatedBun = !('Bun' in globalThis)
    if (simulatedBun) Object.defineProperty(globalThis, 'Bun', { value: {}, configurable: true })
    try {
      const { client } = await fixture()
      const response = await client.authorize()
      expect(
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(response), 'toJSON')?.enumerable,
      ).toBe(false)
      expect(JSON.stringify(response)).not.toContain(ACCOUNT_TOKEN)
      expect(response.authorizationToken).toBe(ACCOUNT_TOKEN)
    } finally {
      if (simulatedBun) Reflect.deleteProperty(globalThis, 'Bun')
    }
  })

  it.each(['client', 'bucket', 'object', 'store'] as const)(
    '%s JSON and spread hide credentials before and after authorization',
    async (name) => {
      const value = await fixture()
      for (const authorized of [false, true]) {
        if (authorized) {
          await value.client.authorize()
          poolTokens(value.store)
        }
        assertNoSecrets(JSON.stringify(value[name]))
        assertNoSecrets(JSON.stringify({ ...value[name] }))
      }
    },
  )

  it('all credential-bearing exported classes redact JSON and spread', async () => {
    const { auth, client, store, bucket, object } = await fixture()
    store.setAuth(auth)
    poolTokens(store)
    const pool = new UploadUrlPool()
    pool.checkin('bucket', entry)
    const sim = new B2Simulator({ partnerAuthorize: true })
    const partnerStore = new InMemoryPartnerAccountInfo()
    const partner = new PartnerClient({
      masterKeyId: 'key-id',
      masterKey: APP_KEY,
      partnerAccountInfo: partnerStore,
      transport: sim.transport(),
    })
    const partnerAuth = await new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport: sim.transport(),
    }).authorize()
    partnerStore.setAuth({ ...partnerAuth, authorizationToken: partnerToken(ACCOUNT_TOKEN) })
    const backup = new BackupClient({
      masterKeyId: 'key-id',
      masterKey: APP_KEY,
      partnerAccountInfo: partnerStore,
      transport: sim.transport(),
    })
    expect(client).toBeInstanceOf(B2Client)
    expect(bucket).toBeInstanceOf(Bucket)
    expect(object).toBeInstanceOf(B2Object)
    for (const value of [client, store, pool, bucket, object, partnerStore, partner, backup]) {
      assertNoSecrets(JSON.stringify(value))
      assertNoSecrets(JSON.stringify({ ...value }))
    }
  })
})
