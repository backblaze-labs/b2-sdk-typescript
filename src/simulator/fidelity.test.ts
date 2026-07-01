import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { sha1Hex } from '../streams/hash.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { BucketType } from '../types/bucket.ts'
import { type EncryptionSetting, SSE_B2, sseCustomer } from '../types/encryption.ts'
import { MetadataDirective } from '../types/file.ts'
import type { LargeFileId } from '../types/ids.ts'
import { EventType } from '../types/notifications.ts'
import type { B2Simulator } from './index.ts'

/**
 * Spec-compliance tests for {@link B2Simulator}. These pin behaviour
 * that matches the published B2 docs at https://www.backblaze.com/apidocs:
 *
 * - Input validation (bucket name, file name, file info, max counts)
 * - Wire-level edges (Content-Range header, Range header forms)
 * - Pluggable post-upload hooks (webhook delivery, replication)
 * - Strict-auth capability + scope + expiry enforcement
 *
 * Each test cites the spec source inline so future maintainers can
 * verify against the live B2 docs.
 */

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('B2Simulator input validation: bucket name', () => {
  let client: B2Client
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('rejects bucket names shorter than 6 characters', async () => {
    await expect(
      client.createBucket({ bucketName: 'short', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/6-63 characters/)
  })

  it('rejects bucket names longer than 63 characters', async () => {
    const tooLong = 'a'.repeat(64)
    await expect(
      client.createBucket({ bucketName: tooLong, bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/6-63 characters/)
  })

  it('rejects bucket names with leading hyphen', async () => {
    await expect(
      client.createBucket({ bucketName: '-leading', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/letters, digits, hyphens, and periods/)
  })

  it('rejects bucket names starting with the reserved "b2-" prefix', async () => {
    await expect(
      client.createBucket({ bucketName: 'b2-reserved', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/reserved prefix/)
  })

  it('accepts a well-formed bucket name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'happy-bucket',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('happy-bucket')
  })

  it('accepts a dotted bucket name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'happy.bucket',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('happy.bucket')
  })
})

describe('B2Simulator input validation: file name', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'filename-validation',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('rejects file names longer than 1024 UTF-8 bytes', async () => {
    // 1025 ASCII chars = 1025 UTF-8 bytes, one over the cap.
    const tooLong = 'a'.repeat(1025)
    await expect(
      bucket.upload({ fileName: tooLong, source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/1024-byte UTF-8 limit/)
  })

  it('rejects file names containing control characters', async () => {
    await expect(
      bucket.upload({
        fileName: 'hasctrl.txt',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/control characters/)
  })

  it('rejects bare "." and ".." as a complete file name', async () => {
    await expect(
      bucket.upload({ fileName: '.', source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/exactly "\." or "\.\."/)
    await expect(
      bucket.upload({ fileName: '..', source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/exactly "\." or "\.\."/)
  })

  it('accepts file names containing ".." as path segments', async () => {
    // `..` as a path segment (e.g. `../foo`) is fine — it's a key, not
    // a filesystem path. Real B2 stores it verbatim.
    const result = await bucket.upload({
      fileName: '../foo.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    expect(result.fileName).toBe('../foo.txt')
  })

  it('rejects file names with a leading slash', async () => {
    await expect(
      bucket.upload({
        fileName: '/leading-slash',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/cannot start with "\/"/)
  })

  it('rejects file names with double-slash segments', async () => {
    await expect(
      bucket.upload({
        fileName: 'a//b.txt',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/"\/\/"/)
  })
})

describe('B2Simulator input validation: maxFileCount caps', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'maxcount-caps',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('rejects b2_list_file_names with pageSize > 10000', async () => {
    await expect(bucket.listFileNames({ pageSize: 10_001 })).rejects.toThrow(/exceeds the/)
  })

  it('rejects b2_list_unfinished_large_files with pageSize > 100', async () => {
    await expect(bucket.listUnfinishedLargeFiles({ pageSize: 101 })).rejects.toThrow(/exceeds the/)
  })

  it('accepts pageSize equal to the documented cap', async () => {
    const page = await bucket.listFileNames({ pageSize: 10_000 })
    expect(page.files).toEqual([])
  })
})

describe('B2Simulator listing order', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'listing-order',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('uses deterministic JS string order instead of locale collation', async () => {
    await bucket.upload({
      fileName: 'a-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.upload({
      fileName: 'Z-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    })

    const names = await bucket.listFileNames()
    expect(names.files.map((file) => file.fileName)).toEqual(['Z-small.txt', 'a-small.txt'])

    const versions = await bucket.listFileVersions()
    expect(versions.files.map((file) => file.fileName)).toEqual(['Z-small.txt', 'a-small.txt'])

    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'a-large.bin',
      contentType: 'application/octet-stream',
    })
    await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'Z-large.bin',
      contentType: 'application/octet-stream',
    })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    expect(unfinished.files.map((file) => file.fileName)).toEqual(['Z-large.bin', 'a-large.bin'])
  })
})

// ---------------------------------------------------------------------------
// Wire-level edges
// ---------------------------------------------------------------------------

describe('B2Simulator wire-level: Content-Range + Range header forms', () => {
  let sim: B2Simulator
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  const fileBytes = new Uint8Array(100).map((_, i) => i)

  beforeEach(async () => {
    ;({ client, sim } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'range-edges',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'numbers.bin',
      source: new BufferSource(fileBytes),
    })
  })

  it('returns 206 + Content-Range header on a closed range', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=10-19' })
    expect(result.headers.contentLength).toBe(10)
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(10, 20))
    // The high-level facade strips Content-Range; route through the
    // raw transport so we can directly assert the header.
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/file/range-edges/numbers.bin',
      headers: { Range: 'bytes=10-19' },
    })
    expect(resp.status).toBe(206)
    expect(resp.headers.get('Content-Range')).toBe(`bytes 10-19/${fileBytes.byteLength}`)
  })

  it('handles bytes=N- (open-ended forward range)', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=90-' })
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(90))
    expect(drained.byteLength).toBe(10)
  })

  it('handles bytes=-N (suffix range, last N bytes)', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=-25' })
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(75))
    expect(drained.byteLength).toBe(25)
  })

  it('returns 416 with bytes */<total> when a range starts past EOF', async () => {
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/file/range-edges/numbers.bin',
      headers: { Range: 'bytes=500-600' },
    })
    expect(resp.status).toBe(416)
    expect(resp.headers.get('Content-Range')).toBe(`bytes */${fileBytes.byteLength}`)
  })
})

// ---------------------------------------------------------------------------
// Pluggable post-upload hooks
// ---------------------------------------------------------------------------

describe('B2Simulator hooks: onWebhookDeliver', () => {
  it('fires for matching event-notification rules', async () => {
    const events: Array<{ ruleName: string; fileName: string }> = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: ({ rule, fileVersion }) => {
          events.push({ ruleName: rule.name, fileName: fileVersion.fileName })
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'webhook-fire',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'all-uploads',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: true,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    await bucket.upload({
      fileName: 'fired.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    // Deterministic flush: wait for every pending hook to settle.
    // Replaces the previous microtask-counting dance, which was
    // brittle (positive case awaited 2 microtasks, negative case 1).
    await sim.flushHooks()
    expect(events).toEqual([{ ruleName: 'all-uploads', fileName: 'fired.bin' }])
  })

  it('does not fire for rules with isEnabled: false', async () => {
    const events: unknown[] = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: (e) => {
          events.push(e)
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'webhook-disabled',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'disabled-rule',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: false,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    await bucket.upload({
      fileName: 'not-fired.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await sim.flushHooks()
    expect(events).toEqual([])
  })

  it('surfaces hook errors via onHookError instead of swallowing them', async () => {
    const errors: Array<{ kind: string; message: string }> = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: () => {
          throw new Error('boom')
        },
        onHookError: ({ kind, error }) => {
          errors.push({ kind, message: error.message })
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'hook-error',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'will-throw',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: true,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    const result = await bucket.upload({
      fileName: 'still-stored.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    // Upload itself succeeded — buggy hook must not corrupt the write.
    expect(result.fileName).toBe('still-stored.bin')
    await sim.flushHooks()
    expect(errors).toEqual([{ kind: 'webhook', message: 'boom' }])
  })
})

// ---------------------------------------------------------------------------
// Strict-auth mode
// ---------------------------------------------------------------------------

describe('B2Simulator strictAuth: capability enforcement', () => {
  async function authorizeWithKey(
    sim: B2Simulator,
    key: { applicationKeyId: string; applicationKey: string },
  ): Promise<B2Client> {
    const client = new B2Client({
      applicationKeyId: key.applicationKeyId,
      applicationKey: key.applicationKey,
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    return client
  }

  it('grants the master credential the documented capability set by default', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    // Master credential has all the common file/bucket caps.
    const allowed = client.accountInfo.getAuth()?.apiInfo.storageApi.allowed
    expect(allowed?.capabilities).toContain(Capability.WriteFiles)
    expect(allowed?.capabilities).toContain(Capability.ListBuckets)
    expect(allowed?.buckets).toBeNull()
    // Master does NOT have BypassGovernance — tests that need it must
    // mint a key with that cap explicitly.
    expect(allowed?.capabilities).not.toContain(Capability.BypassGovernance)
  })

  it('rejects with 401 when the auth token is unknown', async () => {
    const { sim } = makeClient({ sim: { strictAuth: true } })
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_list_buckets',
      headers: { Authorization: 'definitely-not-a-real-token' },
      body: JSON.stringify({ accountId: 'sim_account_0001' }),
    })
    expect(resp.status).toBe(401)
    const body = (await resp.json()) as { code: string }
    expect(body.code).toBe('bad_auth_token')
  })

  it('returns 401 expired_auth_token at the wire level once advanceTime pushes past TTL', async () => {
    // Send via the raw transport (bypassing RetryTransport's reauth
    // loop) so we observe the simulator's wire response, not the
    // SDK's post-reauth retry behaviour.
    const { sim } = makeClient({ sim: { strictAuth: true, authTokenTtlMs: 1000 } })
    const transport = sim.transport()
    const authResp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/b2api/v3/b2_authorize_account',
      headers: { Authorization: `Basic ${btoa('test-key-id:test-key')}` },
    })
    expect(authResp.status).toBe(200)
    const authBody = (await authResp.json()) as { authorizationToken: string }
    const authToken = authBody.authorizationToken

    sim.advanceTime(2000) // push past the 1-second TTL

    const expiredResp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_list_buckets',
      headers: { Authorization: authToken },
      body: JSON.stringify({ accountId: 'sim_account_0001' }),
    })
    expect(expiredResp.status).toBe(401)
    const expiredBody = (await expiredResp.json()) as { code: string }
    expect(expiredBody.code).toBe('expired_auth_token')
  })

  it('enforces single-bucket application key scope from the bucketId alias', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'single-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'single-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'single-scope-key',
      bucketId: allowed.id,
    })
    expect(key.bucketIds).toEqual([allowed.id])

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toEqual([{ id: allowed.id, name: allowed.name }])
    expect(scopedAuth?.bucketId).toBe(allowed.id)
    expect(scopedAuth?.allowed.bucketId).toBe(allowed.id)
    expect(scopedClient.accountInfo.getAllowedBucketId()).toBe(allowed.id)
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toEqual([allowed.id])
    await expect(scopedClient.listBuckets()).rejects.toThrow(/bucket scope is required/)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('enforces multi-bucket application key scope', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const first = await client.createBucket({
      bucketName: 'multi-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'multi-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'multi-scope-c',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'multi-scope-key',
      bucketIds: [first.id, second.id],
    })
    expect(key.bucketIds).toEqual([first.id, second.id])

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ])
    expect(scopedAuth?.bucketId).toBeNull()
    expect(scopedAuth?.allowed.bucketId).toBeNull()
    expect(() => scopedClient.accountInfo.getAllowedBucketId()).toThrow(/exactly one bucket/)
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toEqual([first.id, second.id])
    const directAuthResponse = await sim.transport().send({
      url: 'http://127.0.0.1/b2api/v4/b2_authorize_account',
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:${key.applicationKey}`)}`,
      },
    })
    const directAuth = await directAuthResponse.json<AuthorizeAccountResponse>()
    expect(directAuth.apiInfo.storageApi.allowed.buckets).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ])
    expect(directAuth.apiInfo.storageApi.bucketId).toBeNull()
    expect(directAuth.apiInfo.storageApi.allowed.bucketId).toBeNull()
    await expect(scopedClient.listBuckets()).rejects.toThrow(/bucket scope is required/)
    await expect(scopedClient.listBuckets({ bucketId: first.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: second.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('allows all buckets when application key bucketIds are null', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const first = await client.createBucket({
      bucketName: 'all-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'all-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'all-scope-key',
      bucketIds: null,
    })
    expect(key.bucketIds).toBeNull()

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toBeNull()
    expect(scopedAuth?.bucketId).toBeNull()
    expect(scopedAuth?.allowed.bucketId).toBeNull()
    expect(scopedClient.accountInfo.getAllowedBucketId()).toBeNull()
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toBeNull()
    await expect(scopedClient.listBuckets({ bucketId: first.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: second.id })).resolves.toHaveLength(1)
  })

  it('rejects bucket creation with bucket-scoped application keys', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'create-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const scopedKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'create-scope-key',
      bucketIds: [allowed.id],
    })
    const scopedClient = await authorizeWithKey(sim, scopedKey)

    await expect(
      scopedClient.createBucket({
        bucketName: 'create-scope-denied',
        bucketType: BucketType.AllPrivate,
      }),
    ).rejects.toThrow(/bucket scope is required/)

    const unrestrictedKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'create-all-key',
      bucketIds: null,
    })
    const unrestrictedClient = await authorizeWithKey(sim, unrestrictedKey)
    await expect(
      unrestrictedClient.createBucket({
        bucketName: 'create-scope-allowed',
        bucketType: BucketType.AllPrivate,
      }),
    ).resolves.toMatchObject({ name: 'create-scope-allowed' })
  })

  it('rejects deprecated bucketId on direct v4 b2_create_key simulator requests', async () => {
    const { sim } = makeClient()
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v4/b2_create_key',
      headers: { Authorization: 'unused', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ReadFiles],
        keyName: 'wire-bucket-id',
        bucketId: 'bucket-id',
      }),
    })

    expect(resp.status).toBe(400)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('bucketId is not accepted'),
    })
  })

  it('normalizes legacy bucketId on direct v3 b2_create_key simulator requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'v3-key-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'v3-key-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_key',
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ListBuckets],
        keyName: 'v3-wire-bucket-id',
        bucketId: allowed.id,
      }),
    })

    expect(resp.status).toBe(200)
    const key = (await resp.json()) as {
      applicationKeyId: string
      applicationKey: string
      bucketIds: readonly string[]
      bucketId: string
    }
    expect(key.bucketIds).toEqual([allowed.id])
    expect(key.bucketId).toBe(allowed.id)

    const scopedClient = await authorizeWithKey(sim, key)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('rejects mixed bucketId and bucketIds on direct v3 b2_create_key simulator requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'v3-key-conflict',
      bucketType: BucketType.AllPrivate,
    })
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_key',
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ListBuckets],
        keyName: 'v3-wire-conflict',
        bucketId: bucket.id,
        bucketIds: [bucket.id],
      }),
    })

    expect(resp.status).toBe(400)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('either bucketIds or bucketId'),
    })
  })

  it('keeps stored key scope immutable after request and response arrays mutate', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'immutable-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'immutable-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const requestBucketIds = [allowed.id]
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'immutable-scope-key',
      bucketIds: requestBucketIds,
    })

    requestBucketIds.push(blocked.id)
    ;(key.bucketIds as string[] | null)?.push(blocked.id)

    const scopedClient = await authorizeWithKey(sim, key)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('keeps key operations inside the caller bucket and namePrefix scope', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'key-op-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'key-op-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const parentKey = await client.createKey({
      capabilities: [Capability.ListKeys, Capability.WriteKeys, Capability.DeleteKeys],
      keyName: 'key-op-parent',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/',
    })
    const blockedKey = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'key-op-blocked-bucket',
      bucketIds: [blocked.id],
      namePrefix: 'allowed/',
    })
    const broadKey = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'key-op-broad',
      bucketIds: null,
    })
    const scopedClient = await authorizeWithKey(sim, parentKey)

    await expect(
      scopedClient.createKey({
        capabilities: [Capability.ReadFiles],
        keyName: 'key-op-outside-bucket',
        bucketIds: [blocked.id],
        namePrefix: 'allowed/',
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.createKey({
        capabilities: [Capability.ReadFiles],
        keyName: 'key-op-broader-prefix',
        bucketIds: [allowed.id],
      }),
    ).rejects.toThrow(/outside scope/)

    const childKey = await scopedClient.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'key-op-child',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/reports/',
    })
    expect(childKey.namePrefix).toBe('allowed/reports/')

    const listing = await scopedClient.listKeys()
    const listedNames = listing.keys.map((key) => key.keyName)
    expect(listedNames).toContain('key-op-parent')
    expect(listedNames).toContain('key-op-child')
    expect(listedNames).not.toContain('key-op-blocked-bucket')
    expect(listedNames).not.toContain('key-op-broad')

    await expect(scopedClient.deleteKey(blockedKey.applicationKeyId)).rejects.toThrow(
      /scoped to buckets/,
    )
    await expect(scopedClient.deleteKey(broadKey.applicationKeyId)).rejects.toThrow(
      /bucket scope is required|outside scope/,
    )
    await expect(scopedClient.deleteKey(childKey.applicationKeyId)).resolves.toMatchObject({
      keyName: 'key-op-child',
    })
  })

  it('rejects bucket-scoped file operations outside the key bucketIds', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'file-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'file-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const blockedFile = await blocked.upload({
      fileName: 'blocked.txt',
      source: new BufferSource(new TextEncoder().encode('blocked')),
    })
    const blockedLarge = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: blocked.id,
        fileName: 'blocked-large.bin',
        contentType: 'application/octet-stream',
      },
    )
    const key = await client.createKey({
      capabilities: [
        Capability.ListBuckets,
        Capability.ListFiles,
        Capability.ReadFiles,
        Capability.WriteFiles,
        Capability.DeleteFiles,
      ],
      keyName: 'file-scope-key',
      bucketIds: [allowed.id],
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const downloadUrl = scopedClient.accountInfo.getDownloadUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.listFileNames(apiUrl, authToken, { bucketId: blocked.id }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.getFileInfo(apiUrl, authToken, { fileId: blockedFile.fileId }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: blockedFile.fileId,
        fileName: 'copy.txt',
        destinationBucketId: allowed.id,
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.deleteFileVersion(apiUrl, authToken, {
        fileId: blockedFile.fileId,
        fileName: blockedFile.fileName,
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.getUploadPartUrl(apiUrl, authToken, { fileId: blockedLarge.fileId }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.downloadFileById(downloadUrl, authToken, blockedFile.fileId),
    ).rejects.toThrow(/HTTP 403/)
    await expect(
      scopedClient.raw.downloadFileByName(
        downloadUrl,
        authToken,
        blocked.name,
        blockedFile.fileName,
      ),
    ).rejects.toThrow(/HTTP 403/)
  })

  it('enforces namePrefix on list and download authorization prefixes', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-list-scope',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'allowed/visible.txt',
      source: new BufferSource(new TextEncoder().encode('visible')),
    })
    await bucket.upload({
      fileName: 'blocked/hidden.txt',
      source: new BufferSource(new TextEncoder().encode('hidden')),
    })
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'allowed/incomplete.bin',
        contentType: 'application/octet-stream',
      },
    )
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'blocked/incomplete.bin',
        contentType: 'application/octet-stream',
      },
    )
    const key = await client.createKey({
      capabilities: [Capability.ListFiles, Capability.ShareFiles],
      keyName: 'prefix-list-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.listFileNames(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.listFileVersions(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.listUnfinishedLargeFiles(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: '',
        validDurationInSeconds: 60,
      }),
    ).rejects.toThrow(/outside scope/)

    const names = await scopedClient.raw.listFileNames(apiUrl, authToken, {
      bucketId: bucket.id,
      prefix: 'allowed/',
    })
    expect(names.files.map((file) => file.fileName)).toEqual(['allowed/visible.txt'])

    const versions = await scopedClient.raw.listFileVersions(apiUrl, authToken, {
      bucketId: bucket.id,
      prefix: 'allowed/',
    })
    expect(versions.files.map((file) => file.fileName)).toEqual(['allowed/visible.txt'])

    const unfinished = await scopedClient.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'allowed/',
    })
    expect(unfinished.files.map((file) => file.fileName)).toEqual(['allowed/incomplete.bin'])

    await expect(
      scopedClient.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
      }),
    ).resolves.toMatchObject({ fileNamePrefix: 'allowed/' })
  })

  it('enforces namePrefix on uploads and large-file starts', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-upload-scope',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'prefix-upload-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await scopedClient.raw.getUploadUrl(
      apiUrl,
      authToken,
      { bucketId: bucket.id },
    )

    await expect(
      scopedClient.raw.uploadFile(
        uploadUrl,
        {
          authorization: authorizationToken,
          fileName: 'blocked/upload.txt',
          contentLength: 1,
          contentSha1: 'do_not_verify',
          contentType: 'text/plain',
        },
        new Uint8Array([1]).buffer,
      ),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.uploadFile(
        uploadUrl,
        {
          authorization: authorizationToken,
          fileName: 'allowed/upload.txt',
          contentLength: 1,
          contentSha1: 'do_not_verify',
          contentType: 'text/plain',
        },
        new Uint8Array([1]).buffer,
      ),
    ).resolves.toMatchObject({ fileName: 'allowed/upload.txt' })
    await expect(
      scopedClient.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucket.id,
        fileName: 'blocked/large.bin',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucket.id,
        fileName: 'allowed/large.bin',
        contentType: 'application/octet-stream',
      }),
    ).resolves.toMatchObject({ fileName: 'allowed/large.bin' })
  })

  it('handles malformed encoded upload file names during strict auth', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'malformed-upload-name',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'malformed-upload-name-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await scopedClient.raw.getUploadUrl(
      apiUrl,
      authToken,
      { bucketId: bucket.id },
    )

    const resp = await sim.transport().send({
      method: 'POST',
      url: uploadUrl,
      headers: {
        Authorization: authorizationToken,
        'Content-Type': 'application/octet-stream',
        'X-Bz-Content-Sha1': 'do_not_verify',
        'X-Bz-File-Name': 'blocked%zz.txt',
      },
      body: new Uint8Array([1]).buffer,
    })

    expect(resp.status).toBe(403)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('outside scope'),
    })
  })

  it('enforces namePrefix on copy source and destination names', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-copy-scope',
      bucketType: BucketType.AllPrivate,
    })
    const allowedSource = await bucket.upload({
      fileName: 'allowed/source.txt',
      source: new BufferSource(new TextEncoder().encode('allowed source')),
    })
    const blockedSource = await bucket.upload({
      fileName: 'blocked/source.txt',
      source: new BufferSource(new TextEncoder().encode('blocked source')),
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'prefix-copy-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: blockedSource.fileId,
        fileName: 'allowed/from-blocked.txt',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: allowedSource.fileId,
        fileName: 'blocked/from-allowed.txt',
      }),
    ).rejects.toThrow(/outside scope/)

    const copy = await scopedClient.raw.copyFile(apiUrl, authToken, {
      sourceFileId: allowedSource.fileId,
      fileName: 'allowed/copy.txt',
    })
    expect(copy.fileName).toBe('allowed/copy.txt')
  })

  it('enforces bucket and namePrefix scope on notification rules', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'notify-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'notify-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ReadBucketNotifications, Capability.WriteBucketNotifications],
      keyName: 'notify-scope-key',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const allowedRule = {
      eventTypes: [EventType.ObjectCreatedAll],
      isEnabled: true,
      isSuspended: false,
      name: 'allowed-rule',
      objectNamePrefix: 'allowed/',
      suspensionReason: '',
      targetConfiguration: { targetType: 'url', url: 'https://example.com/allowed' },
    }
    const blockedRule = {
      ...allowedRule,
      name: 'blocked-rule',
      objectNamePrefix: 'blocked/',
    }

    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: blocked.id,
        eventNotificationRules: [allowedRule],
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [blockedRule],
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [allowedRule],
      }),
    ).resolves.toMatchObject({
      bucketId: allowed.id,
      eventNotificationRules: [allowedRule],
    })
    await expect(
      scopedClient.raw.getBucketNotificationRules(apiUrl, authToken, { bucketId: blocked.id }),
    ).rejects.toThrow(/scoped to buckets/)
  })

  it('enforces bucket and namePrefix scope on object-lock updates', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'lock-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'lock-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const allowedFile = await allowed.upload({
      fileName: 'allowed/legal.txt',
      source: new BufferSource(new TextEncoder().encode('allowed')),
    })
    const blockedPrefixFile = await allowed.upload({
      fileName: 'blocked/legal.txt',
      source: new BufferSource(new TextEncoder().encode('blocked prefix')),
    })
    const blockedBucketFile = await blocked.upload({
      fileName: 'allowed/legal.txt',
      source: new BufferSource(new TextEncoder().encode('blocked bucket')),
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFileLegalHolds, Capability.WriteFileRetentions],
      keyName: 'lock-scope-key',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.updateFileLegalHold(apiUrl, authToken, {
        fileId: blockedBucketFile.fileId,
        fileName: blockedBucketFile.fileName,
        legalHold: 'on',
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.updateFileLegalHold(apiUrl, authToken, {
        fileId: blockedPrefixFile.fileId,
        fileName: blockedPrefixFile.fileName,
        legalHold: 'on',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.updateFileRetention(apiUrl, authToken, {
        fileId: allowedFile.fileId,
        fileName: allowedFile.fileName,
        fileRetention: { mode: null, retainUntilTimestamp: null },
      }),
    ).resolves.toMatchObject({
      fileId: allowedFile.fileId,
      fileName: allowedFile.fileName,
    })
  })
})

// ---------------------------------------------------------------------------
// Upload integrity: SHA-1 verification (spec: b2_upload_file rejects with
// 400 "Sha1 did not match data received" when the header disagrees with the
// bytes) and fileInfo round-trip.
// ---------------------------------------------------------------------------

describe('B2Simulator upload SHA-1 verification', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    // maxRetries: 0 so a deliberate 400 surfaces immediately, no backoff.
    ;({ client } = makeClient({ client: { retry: { maxRetries: 0 } } }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'sha1-fidelity',
      bucketType: BucketType.AllPrivate,
    })
  })

  /** Upload `data` straight through the raw client with an explicit sha1 header. */
  async function rawUpload(
    fileName: string,
    data: Uint8Array,
    contentSha1: string,
    serverSideEncryption?: EncryptionSetting,
  ) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await client.raw.getUploadUrl(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    return client.raw.uploadFile(
      uploadUrl,
      {
        authorization: authorizationToken,
        fileName,
        contentType: 'text/plain',
        contentLength: data.byteLength,
        contentSha1,
        ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
      },
      data as BodyInit,
    )
  }

  it('rejects an upload whose X-Bz-Content-Sha1 does not match the bytes', async () => {
    const data = new TextEncoder().encode('hello world')
    await expect(rawUpload('mismatch.txt', data, '0'.repeat(40))).rejects.toThrow(
      /Sha1 did not match/i,
    )
  })

  it('accepts an upload whose sha1 matches and stores it', async () => {
    const data = new TextEncoder().encode('verified content')
    const hash = await sha1Hex(data)
    const fv = await rawUpload('match.txt', data, hash)
    expect(fv.contentSha1).toBe(hash)
  })

  it('returns B2 null no-encryption shapes from public upload responses', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const small = await rawUpload(
      'no-encryption-small.txt',
      new TextEncoder().encode('plain'),
      await sha1Hex(new TextEncoder().encode('plain')),
    )
    expect(small.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'no-encryption-large.bin',
      contentType: 'application/octet-stream',
    })
    expect(start.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'no-encryption-large.bin',
    })
    expect(unfinished.files[0]?.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId,
    })
    const part = new Uint8Array(1024).fill(1)
    const uploadedPart = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part.byteLength,
        contentSha1: await sha1Hex(part),
      },
      part as BodyInit,
    )
    expect(uploadedPart.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: start.fileId,
      partSha1Array: [uploadedPart.contentSha1],
    })
    expect(finished.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const listed = await bucket.listFileNames({ prefix: 'no-encryption' })
    expect(listed.files.map((file) => file.serverSideEncryption)).toEqual([
      { mode: null, algorithm: null },
      { mode: null, algorithm: null },
    ])
  })

  it('returns explicit encryption settings from single-file upload responses', async () => {
    const sseB2Data = new TextEncoder().encode('managed key')
    const sseB2 = await rawUpload('sse-b2-small.txt', sseB2Data, await sha1Hex(sseB2Data), SSE_B2)
    expect(sseB2.serverSideEncryption).toEqual(SSE_B2)

    const sseCData = new TextEncoder().encode('customer key')
    const sseC = await rawUpload(
      'sse-c-small.txt',
      sseCData,
      await sha1Hex(sseCData),
      sseCustomer('customer-key', 'customer-key-md5'),
    )
    expect(sseC.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
  })

  it('skips verification for the do_not_verify sentinel (no stored sha1)', async () => {
    const data = new TextEncoder().encode('unchecked')
    // The simulator stores 'none'; the raw client normalizes that sentinel to null.
    const fv = await rawUpload('skip.txt', data, 'do_not_verify')
    expect(fv.contentSha1).toBeNull()
  })

  it('stores the hash verbatim without verifying for the unverified: prefix', async () => {
    const data = new TextEncoder().encode('claimed but unchecked')
    // A wrong hash behind `unverified:` is accepted as-is (no verification).
    const fv = await rawUpload('unverified.txt', data, `unverified:${'a'.repeat(40)}`)
    expect(fv.contentSha1).toBe('a'.repeat(40))
  })

  it('verifies and strips the trailing digest for hex_digits_at_end', async () => {
    // Trailing-SHA mode: the last 40 bytes are the hex digest, not file content.
    const content = new TextEncoder().encode('trailing sha mode content')
    const digest = await sha1Hex(content)
    const body = new Uint8Array(content.byteLength + 40)
    body.set(content, 0)
    body.set(new TextEncoder().encode(digest), content.byteLength)
    const fv = await rawUpload('trailer.txt', body, 'hex_digits_at_end')
    // Stored length excludes the 40-byte trailer; stored sha1 is the digest.
    expect(fv.contentLength).toBe(content.byteLength)
    expect(fv.contentSha1).toBe(digest)
  })

  it('rejects hex_digits_at_end when the trailing digest does not match', async () => {
    const content = new TextEncoder().encode('bad trailer content')
    const body = new Uint8Array(content.byteLength + 40)
    body.set(content, 0)
    body.set(new TextEncoder().encode('0'.repeat(40)), content.byteLength)
    await expect(rawUpload('bad-trailer.txt', body, 'hex_digits_at_end')).rejects.toThrow(
      /Sha1 did not match/i,
    )
  })

  it('rejects an uploaded part whose sha1 does not match the bytes', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'parts.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId as unknown as LargeFileId,
    })
    const part = new Uint8Array(1024).fill(7)
    await expect(
      client.raw.uploadPart(
        partUrl.uploadUrl,
        {
          authorization: partUrl.authorizationToken,
          partNumber: 1,
          contentLength: part.byteLength,
          contentSha1: '0'.repeat(40),
        },
        part as BodyInit,
      ),
    ).rejects.toThrow(/Sha1 did not match/i)
  })

  it('rejects finishLargeFile when a partSha1Array entry does not match the uploaded part', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'finish-mismatch.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId as unknown as LargeFileId,
    })
    const part = new Uint8Array(1024).fill(9)
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part.byteLength,
        contentSha1: await sha1Hex(part),
      },
      part as BodyInit,
    )
    // The part uploaded fine, but finish supplies the wrong checksum for it.
    await expect(
      client.raw.finishLargeFile(apiUrl, authToken, {
        fileId: start.fileId as unknown as LargeFileId,
        partSha1Array: ['0'.repeat(40)],
      }),
    ).rejects.toThrow(/does not match the uploaded part/i)
  })
})

describe('B2Simulator upload fileInfo round-trip', () => {
  let client: B2Client
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('persists custom fileInfo and returns it from getFileInfoByName', async () => {
    const bucket = await client.createBucket({
      bucketName: 'fileinfo-rt',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'meta.txt',
      source: new BufferSource(new TextEncoder().encode('hi')),
      fileInfo: { color: 'blue', purpose: 'test' },
    })
    const info = await bucket.getFileInfoByName('meta.txt')
    expect(info?.fileInfo).toMatchObject({ color: 'blue', purpose: 'test' })
  })

  it('persists fileInfo through a multipart (large-file) upload', async () => {
    // Small recommendedPartSize forces the multipart path (size > part size).
    const { client: mpClient } = makeClient({
      sim: { minimumPartSize: 1024, recommendedPartSize: 1024 },
    })
    await mpClient.authorize()
    const bucket = await mpClient.createBucket({
      bucketName: 'mp-fileinfo',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'big-meta.bin',
      source: new BufferSource(new Uint8Array(3000).fill(1)),
      fileInfo: { kind: 'multipart', owner: 'qa' },
    })
    const info = await bucket.getFileInfoByName('big-meta.bin')
    expect(info?.fileInfo).toMatchObject({ kind: 'multipart', owner: 'qa' })
  })

  it('returns fileInfo via download(), not just getFileInfo', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-fileinfo',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'dl-meta.txt',
      source: new BufferSource(new TextEncoder().encode('hi')),
      // Value with a space exercises the B2 wire encoding (encodeFileName)
      // round-trip, not just plain alphanumerics.
      fileInfo: { color: 'forest green' },
    })
    const result = await bucket.download('dl-meta.txt')
    await new Response(result.body).arrayBuffer() // drain to release the stream
    expect(result.headers.fileInfo).toMatchObject({ color: 'forest green' })
  })
})

describe('B2Simulator download header encoding', () => {
  it('encodes X-Bz-File-Name with B2 encodeFileName (preserves B2-safe chars)', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'name-encoding',
      bucketType: BucketType.AllPrivate,
    })
    // '=' and '@' are B2-safe (encodeFileName preserves them); encodeURIComponent
    // would percent-escape them. Assert the raw response header matches B2.
    await bucket.upload({
      fileName: 'release=v1@main.txt',
      source: new BufferSource(new TextEncoder().encode('x')),
    })
    const resp = await sim.transport().send({
      method: 'GET',
      url: 'http://localhost:0/file/name-encoding/release=v1@main.txt',
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('X-Bz-File-Name')).toBe('release=v1@main.txt')
  })
})

// ---------------------------------------------------------------------------
// copy_file: metadataDirective (COPY/REPLACE), contentType, fileInfo, range
// ---------------------------------------------------------------------------

describe('B2Simulator copy_file fidelity', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'copy-fidelity',
      bucketType: BucketType.AllPrivate,
    })
  })

  /** Upload a 10-byte source file with metadata, return its FileVersion. */
  async function uploadSource(fileName: string) {
    return bucket.upload({
      fileName,
      source: new BufferSource(new TextEncoder().encode('abcdefghij')),
      contentType: 'text/markdown',
      fileInfo: { origin: 'src', tag: 'v1' },
    })
  }

  function rawCopy(req: Parameters<typeof client.raw.copyFile>[2]) {
    return client.raw.copyFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      req,
    )
  }

  it('COPY directive (default) preserves the source contentType and fileInfo', async () => {
    const src = await uploadSource('src-copy.txt')
    const copy = await rawCopy({ sourceFileId: src.fileId, fileName: 'dst-copy.txt' })
    expect(copy.contentType).toBe('text/markdown')
    expect(copy.fileInfo).toMatchObject({ origin: 'src', tag: 'v1' })
    expect(copy.contentLength).toBe(10)
  })

  it('REPLACE directive applies the request contentType and fileInfo', async () => {
    const src = await uploadSource('src-replace.txt')
    const copy = await rawCopy({
      sourceFileId: src.fileId,
      fileName: 'dst-replace.txt',
      metadataDirective: MetadataDirective.Replace,
      contentType: 'application/json',
      fileInfo: { origin: 'replaced', extra: 'yes' },
    })
    expect(copy.contentType).toBe('application/json')
    expect(copy.fileInfo).toMatchObject({ origin: 'replaced', extra: 'yes' })
    expect(copy.fileInfo).not.toHaveProperty('tag') // source's fileInfo not carried over
  })

  it('rejects REPLACE without a contentType (400)', async () => {
    const src = await uploadSource('src-replace-no-type.txt')
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-replace-no-type.txt',
        metadataDirective: MetadataDirective.Replace,
      }),
    ).rejects.toThrow(/contentType is required/i)
  })

  it('copies only the requested byte range and recomputes its sha1', async () => {
    const bytes = new TextEncoder().encode('abcdefghij')
    const src = await bucket.upload({ fileName: 'src-range.txt', source: new BufferSource(bytes) })
    const copy = await rawCopy({
      sourceFileId: src.fileId,
      fileName: 'dst-range.txt',
      range: 'bytes=0-3', // first 4 bytes -> 'abcd'
    })
    expect(copy.contentLength).toBe(4)
    expect(copy.contentSha1).toBe(await sha1Hex(bytes.slice(0, 4)))
    // The stored bytes are the slice, not the whole source.
    const dl = await bucket.download('dst-range.txt')
    const data = new Uint8Array(await new Response(dl.body).arrayBuffer())
    expect(new TextDecoder().decode(data)).toBe('abcd')
  })

  it('rejects an unsatisfiable copy range with 416', async () => {
    const src = await bucket.upload({
      fileName: 'src-badrange.txt',
      source: new BufferSource(new TextEncoder().encode('abc')),
    })
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-badrange.txt',
        range: 'bytes=100-200', // well-formed but past EOF (3 bytes)
      }),
    ).rejects.toThrow(/Unsatisfiable copy range/i)
  })

  it.each([
    'bytes=abc',
    'bytes=5-1',
    'bytes=-0',
  ])('rejects a malformed copy range (%s) with 400, not 416', async (range) => {
    const src = await bucket.upload({
      fileName: `src-malformed-${range.replace(/[^a-z0-9]/gi, '')}.txt`,
      source: new BufferSource(new TextEncoder().encode('abcdefghij')),
    })
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: `dst-${range.replace(/[^a-z0-9]/gi, '')}.txt`,
        range,
      }),
    ).rejects.toThrow(/Malformed copy range/i)
  })

  it('rejects replacement contentType/fileInfo in COPY (default) mode', async () => {
    const src = await uploadSource('src-copy-with-meta.txt')
    // contentType supplied without REPLACE.
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-ct.txt',
        contentType: 'application/json',
      }),
    ).rejects.toThrow(/may only be set when metadataDirective is REPLACE/i)
    // fileInfo supplied without REPLACE.
    await expect(
      rawCopy({ sourceFileId: src.fileId, fileName: 'dst-fi.txt', fileInfo: { a: 'b' } }),
    ).rejects.toThrow(/may only be set when metadataDirective is REPLACE/i)
  })

  it('rejects an unknown metadataDirective', async () => {
    const src = await uploadSource('src-bad-directive.txt')
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-bad-directive.txt',
        metadataDirective: 'MERGE' as never,
      }),
    ).rejects.toThrow(/Invalid metadataDirective/i)
  })
})
