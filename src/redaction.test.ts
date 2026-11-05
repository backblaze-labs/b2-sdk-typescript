import { describe, expect, it } from 'vitest'
import type { AccountInfo } from './auth/account-info.ts'
import { UploadUrlPool } from './auth/index.ts'
import { BackupClient } from './backup/index.ts'
import { DEFAULT_RETRY_OPTIONS } from './http/retry.ts'
import { B2Client, B2Object, Bucket, InMemoryAccountInfo } from './index.ts'
import { InMemoryPartnerAccountInfo, PartnerClient } from './partner/index.ts'
import { APPLICATION_KEY_REDACTED } from './partner/redaction-placeholders.ts'
import { B2Simulator } from './simulator/index.ts'
import { jsonResponse } from './test-utils/index.ts'
import type { AuthorizeAccountResponse } from './types/auth.ts'
import { type BucketInfo, BucketType } from './types/bucket.ts'
import { type AuthToken, bucketId, partnerToken } from './types/ids.ts'

const APP_KEY = 'SECRET-APPKEY'
const ACCOUNT_TOKEN = 'SECRET-ACCOUNT-TOKEN'
const UPLOAD_TOKEN = 'SECRET-UPLOAD-TOKEN'
const PART_TOKEN = 'SECRET-PART-UPLOAD-TOKEN'
const SECRETS = [APP_KEY, ACCOUNT_TOKEN, UPLOAD_TOKEN, PART_TOKEN]
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
      async send() {
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

describe('credential redaction JSON and spread', () => {
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
    expect(JSON.parse(JSON.stringify(response)).authorizationToken).toBe(ACCOUNT_TOKEN)
    expect(client.accountInfo).toBe(store)
    poolTokens(store)
    expect(store.checkoutUploadUrl(BID)?.authorizationToken).toBe(UPLOAD_TOKEN)
    expect(store.checkoutPartUploadUrl('large-file-id')?.authorizationToken).toBe(PART_TOKEN)
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
