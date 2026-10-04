import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { bucketId } from '../types/ids.ts'
import { FileAccountInfo } from './file.ts'

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
          buckets: null,
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

  it('loads legacy cached auth without allowed.buckets', async () => {
    const legacyBucketId = bucketId('legacy-cache-bucket')
    const cached = makeCachedAuth()
    await writeFile(
      storePath,
      JSON.stringify({
        ...cached,
        apiInfo: {
          storageApi: {
            ...cached.apiInfo.storageApi,
            bucketId: legacyBucketId,
            bucketName: 'legacy-cache',
            allowed: {
              capabilities: [Capability.ListBuckets],
              bucketId: legacyBucketId,
              bucketName: 'legacy-cache',
              namePrefix: null,
            },
          },
        },
      }),
      'utf8',
    )
    const accountInfo = new FileAccountInfo(storePath)

    await accountInfo.load()

    expect(accountInfo.getAllowedBucketId()).toBe(legacyBucketId)
    expect(accountInfo.getAllowedBucketIds()).toEqual([legacyBucketId])
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

  it('rejects custom-realm sibling endpoints under Backblaze-owned suffixes', async () => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: 'https://api.backblazeb2.com/api',
        downloadUrl: 'https://f001.backblazeb2.com/download',
        s3ApiUrl: 'https://s3.us-west-001.backblazeb2.com/s3',
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'https://auth.backblazeb2.com',
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
        realm: 'https://auth.backblazeb2.com',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects a custom-realm cache whose endpoints are sibling public-suffix hosts', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        ...makeCachedAuth({
          apiUrl: 'https://attacker.ngrok-free.app/api',
          downloadUrl: 'https://attacker.ngrok-free.app/download',
          s3ApiUrl: 'https://attacker.ngrok-free.app/s3',
        }),
        _b2sdk: {
          version: 1,
          realmUrl: 'https://victim.ngrok-free.app',
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

    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn<typeof fetch>()
    globalThis.fetch = fetchSpy
    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        realm: 'https://victim.ngrok-free.app',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([
    ['sibling IPv4', 'http://127.0.0.2:8180'],
    ['localhost alias', 'http://localhost:8180'],
    ['IPv6 alias', 'http://[::1]:8180'],
    ['different port', 'http://127.0.0.1:9999'],
  ])('rejects %s loopback endpoints for a loopback realm', async (_label, endpoint) => {
    const cached = JSON.stringify({
      ...makeCachedAuth({
        apiUrl: `${endpoint}/api`,
        downloadUrl: `${endpoint}/download`,
        s3ApiUrl: `${endpoint}/s3`,
      }),
      _b2sdk: {
        version: 1,
        realmUrl: 'http://127.0.0.1:8180',
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
        realm: 'http://127.0.0.1:8180',
        accountInfo,
      })

      expect(client.accountInfo.getAuth()).toBeNull()
      expect(discards).toEqual(['endpoint_mismatch'])
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readFile(storePath, 'utf8')).toBe(cached)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
