import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { BucketType } from '../types/bucket.ts'
import { FileAccountInfo } from './file.ts'
import { InMemoryAccountInfo } from './in-memory.ts'

function makeCachedAuth(
  endpoints: Partial<{
    apiUrl: string
    downloadUrl: string
    s3ApiUrl: string
  }> = {},
): AuthorizeAccountResponse {
  return {
    accountId: 'cached-account' as AuthorizeAccountResponse['accountId'],
    authorizationToken: 'cached-token' as AuthorizeAccountResponse['authorizationToken'],
    apiInfo: {
      storageApi: {
        apiUrl: endpoints.apiUrl ?? 'https://api001.backblazeb2.com',
        bucketId: null,
        bucketName: null,
        downloadUrl: endpoints.downloadUrl ?? 'https://f001.backblazeb2.com',
        infoType: 'storageApi',
        namePrefix: null,
        s3ApiUrl: endpoints.s3ApiUrl ?? 'https://s3.us-west-001.backblazeb2.com',
        absoluteMinimumPartSize: 5_000_000,
        recommendedPartSize: 100_000_000,
        allowed: {
          capabilities: [Capability.ListBuckets],
          bucketId: null,
          bucketName: null,
          namePrefix: null,
        },
      },
    },
    applicationKeyExpirationTimestamp: null,
  }
}

describe('FileAccountInfo', () => {
  let tempDir: string
  let storePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'b2sdk-fileaccount-'))
    storePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('round-trips authorization through disk', async () => {
    const sim = new B2Simulator()
    const accountInfo1 = new FileAccountInfo(storePath)
    await accountInfo1.load() // empty initially

    const client1 = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo: accountInfo1,
    })
    await client1.authorize()
    await accountInfo1.flushed()

    const auth1 = accountInfo1.getAuth()
    expect(auth1).toBeTruthy()
    expect(auth1?.accountId).toBe('sim_account_0001')

    // Simulate a process restart: new FileAccountInfo instance, same path.
    const accountInfo2 = new FileAccountInfo(storePath)
    await accountInfo2.load()
    const auth2 = accountInfo2.getAuth()
    expect(auth2?.accountId).toBe(auth1?.accountId)
    expect(auth2?.authorizationToken).toBe(auth1?.authorizationToken)
    expect(accountInfo2.getApiUrl()).toBe(accountInfo1.getApiUrl())

    const client2 = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo: accountInfo2,
    })
    expect(client2.accountInfo.getAuth()).not.toBeNull()
  })

  it('load() returns silently on missing file', async () => {
    const accountInfo = new FileAccountInfo(join(tempDir, 'does-not-exist.json'))
    await expect(accountInfo.load()).resolves.toBeUndefined()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('load() returns silently on corrupt JSON', async () => {
    await writeFile(storePath, 'not valid json', 'utf8')
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('ignores cache files with an unsupported SDK metadata version', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth(),
        _b2sdk: {
          version: 2,
          realmUrl: 'https://api.backblazeb2.com',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()
    expect(accountInfo.getAuth()).toBeNull()
  })

  it('clear() wipes both memory and disk state', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    accountInfo.clear()
    await accountInfo.flushed()

    expect(accountInfo.getAuth()).toBeNull()
    // File still exists but should be empty.
    const onDisk = await readFile(storePath, 'utf8').catch(() => '')
    expect(onDisk).toBe('')
  })

  it('writes the cache file with owner-only permissions on POSIX platforms', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    if (process.platform === 'win32') {
      return
    }

    expect((await stat(storePath)).mode & 0o777).toBe(0o600)
  })

  it('replaces a broadly-readable cache file with a private atomic write', async () => {
    await writeFile(storePath, '{"stale":true}', { encoding: 'utf8', mode: 0o666 })
    await chmod(storePath, 0o666)

    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as {
      _b2sdk?: { realmUrl?: string; applicationKeyId?: string }
      accountId?: string
      auth?: { accountId?: string }
      realmUrl?: string
    }
    expect(onDisk.auth?.accountId ?? onDisk.accountId).toBe('sim_account_0001')
    expect(onDisk._b2sdk?.realmUrl).toBe('https://api.backblazeb2.com')
    expect(onDisk._b2sdk?.applicationKeyId).toBe('test-key-id')
    expect(await readdir(tempDir)).toEqual(['auth.json'])

    if (process.platform !== 'win32') {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('writes auth at the top level so older readers can re-use the cache', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as AuthorizeAccountResponse & {
      _b2sdk?: { realmUrl?: string; applicationKeyId?: string }
    }
    const oldReader = new InMemoryAccountInfo()
    oldReader.setAuth(onDisk)

    expect(onDisk._b2sdk?.realmUrl).toBe('https://api.backblazeb2.com')
    expect(onDisk._b2sdk?.applicationKeyId).toBe('test-key-id')
    expect(oldReader.getApiUrl()).toBe(accountInfo.getApiUrl())
  })

  it('persists across multiple setAuth calls', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await client.authorize() // re-auth
    await accountInfo.flushed()

    const loaded = new FileAccountInfo(storePath)
    await loaded.load()
    expect(loaded.getAuth()).toBeTruthy()
  })

  it('ignores a legacy cache when bound to a client key without clobbering disk', async () => {
    const cached = JSON.stringify(makeCachedAuth())
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: new B2Simulator().transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['application_key_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('retains a legacy production cache only when endpoints match production', async () => {
    await writeFile(storePath, JSON.stringify(makeCachedAuth()), 'utf8')
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()

    accountInfo.setRealmUrl('https://api.backblazeb2.com')

    expect(accountInfo.getAuth()).not.toBeNull()
  })

  it('ignores a legacy custom-realm cache when bound to production', async () => {
    const cached = JSON.stringify(
      makeCachedAuth({
        apiUrl: 'https://api.custom.example',
        downloadUrl: 'https://download.custom.example',
        s3ApiUrl: 'https://s3.custom.example',
      }),
    )
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    accountInfo.setRealmUrl('https://api.backblazeb2.com')

    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['realm_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('ignores a persisted auth cache when the stored realm differs without clobbering disk', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: new B2Simulator().transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['realm_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('ignores a persisted auth cache when the stored application key differs', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'privileged-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()
    expect(accountInfo.getAuth()).not.toBeNull()

    const client = new B2Client({
      applicationKeyId: 'restricted-key-id',
      applicationKey: 'test-key',
      transport: new B2Simulator().transport(),
      accountInfo,
    })

    expect(client.accountInfo).toBe(accountInfo)
    expect(accountInfo.getAuth()).toBeNull()
    await accountInfo.flushed()
    expect(discards).toEqual(['application_key_mismatch'])
    expect(await readFile(storePath, 'utf8')).toBe(cached)
  })

  it('does not let a staging-bound client clobber a production cache from another process', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth(),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')

    const stagingAccountInfo = new FileAccountInfo(storePath)
    await stagingAccountInfo.load()
    const stagingClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: new B2Simulator().transport(),
      accountInfo: stagingAccountInfo,
    })

    expect(stagingClient.accountInfo.getAuth()).toBeNull()
    expect(await readFile(storePath, 'utf8')).toBe(cached)

    const productionAccountInfo = new FileAccountInfo(storePath)
    await productionAccountInfo.load()
    const productionClient = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: new B2Simulator().transport(),
      accountInfo: productionAccountInfo,
    })

    expect(productionClient.accountInfo.getAuth()).not.toBeNull()
  })

  it('ignores a matching-metadata cache whose endpoints do not match the realm', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: 'https://attacker.example/api',
        downloadUrl: 'https://attacker.example/download',
        s3ApiUrl: 'https://attacker.example/s3',
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://api.backblazeb2.com',
        applicationKeyId: 'test-key-id',
      },
    })
    await writeFile(storePath, cached, 'utf8')
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(() => client.accountInfo.getApiUrl()).toThrow('Not authorized')
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('locks the default URL guard from retained cached auth', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth(),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://api.backblazeb2.com',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(client.urlGuard?.getAllowedSuffixes()).toContain('backblazeb2.com')
  })

  it('retains a staging cache whose endpoints are sibling staging hosts', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://api001.backblaze.net',
          downloadUrl: 'https://f001.backblaze.net',
          s3ApiUrl: 'https://s3.us-west-001.backblaze.net',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://api.backblaze.net',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'staging',
      transport: new B2Simulator().transport(),
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(discards).toEqual([])
  })

  it('retains a custom-realm cache whose endpoints share the realm parent domain', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://api.custom.example',
          downloadUrl: 'https://download.custom.example',
          s3ApiUrl: 'https://s3.custom.example',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://auth.custom.example',
          applicationKeyId: 'test-key-id',
        },
      }),
      'utf8',
    )
    const discards: string[] = []
    const accountInfo = new FileAccountInfo(storePath, {
      onDiscard: (event) => discards.push(event.reason),
    })
    await accountInfo.load()

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: 'https://auth.custom.example',
      transport: new B2Simulator().transport(),
      accountInfo,
    })

    expect(client.accountInfo.getAuth()).not.toBeNull()
    expect(discards).toEqual([])
  })

  it('delegates every AccountInfo getter to the in-memory backing', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()

    expect(accountInfo.getAccountId()).toBe('sim_account_0001')
    expect(accountInfo.getApiUrl()).toBeTruthy()
    expect(accountInfo.getDownloadUrl()).toBeTruthy()
    expect(accountInfo.getAuthToken()).toBeTruthy()
    expect(accountInfo.getRecommendedPartSize()).toBeGreaterThan(0)
    expect(accountInfo.getAbsoluteMinimumPartSize()).toBeGreaterThan(0)
    expect(accountInfo.getS3ApiUrl()).toBeTruthy()
    expect(accountInfo.getAllowedBucketId()).toBeNull()
  })

  it('delegates the upload URL pool methods to the in-memory backing', async () => {
    const sim = new B2Simulator()
    const accountInfo = new FileAccountInfo(storePath)
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      accountInfo,
    })
    await client.authorize()
    await accountInfo.flushed()
    const bucket = await client.createBucket({
      bucketName: 'pool-delegate',
      bucketType: BucketType.AllPrivate,
    })

    const entry = { uploadUrl: 'http://u', authorizationToken: 'tok' }
    accountInfo.returnUploadUrl(bucket.id, entry)
    expect(accountInfo.checkoutUploadUrl(bucket.id)).toEqual(entry)
    accountInfo.returnUploadUrl(bucket.id, entry)
    accountInfo.evictUploadUrl(bucket.id, entry)
    expect(accountInfo.checkoutUploadUrl(bucket.id)).toBeNull()

    const partEntry = { uploadUrl: 'http://p', authorizationToken: 'ptok' }
    accountInfo.returnPartUploadUrl('file-id', partEntry)
    expect(accountInfo.checkoutPartUploadUrl('file-id')).toEqual(partEntry)
    accountInfo.returnPartUploadUrl('file-id', partEntry)
    accountInfo.evictPartUploadUrl('file-id', partEntry)
    expect(accountInfo.checkoutPartUploadUrl('file-id')).toBeNull()
  })
})
