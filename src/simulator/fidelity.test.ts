import { beforeEach, describe, expect, it } from 'vitest'
import type { B2Client } from '../client.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { Capability } from '../types/auth.ts'
import { BucketType } from '../types/bucket.ts'
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
    ).rejects.toThrow(/letters, digits, and hyphens/)
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
  it('grants the master credential the documented capability set by default', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    // Master credential has all the common file/bucket caps.
    const allowed = client.accountInfo.getAuth()?.apiInfo.storageApi.allowed
    expect(allowed?.capabilities).toContain(Capability.WriteFiles)
    expect(allowed?.capabilities).toContain(Capability.ListBuckets)
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
})
