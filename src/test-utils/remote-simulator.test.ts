import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Error } from '../errors/index.ts'
import { BucketType } from '../types/bucket.ts'
import { makeRemoteClient, resetRemoteSimulator, toResetConfig } from './remote-simulator.ts'

describe('toResetConfig (B2SimulatorOptions -> POST /reset config)', () => {
  it('pins the embedded simulator defaults the ts-sdk profile does not share', () => {
    // The embedded B2Simulator defaults to permissive auth and no Partner
    // authorizer; the standalone server's profile defaults to strict auth and the
    // Partner authorizer, so both must be sent explicitly on every reset.
    expect(toResetConfig()).toEqual({
      profile: 'ts-sdk',
      strictAuth: false,
      partnerAuthorize: false,
    })
    expect(toResetConfig({})).toEqual(toResetConfig())
  })

  it('passes every option the standalone server accepts through unchanged', () => {
    expect(
      toResetConfig({
        minimumPartSize: 10,
        recommendedPartSize: 20,
        strictAuth: true,
        authTokenTtlMs: 1000,
        partnerAuthorize: true,
        partnerApiEnabled: false,
        partnerAccountHasValidPhone: false,
        partnerAccountInGoodStanding: false,
        customUploadTimestampsEnabled: true,
      }),
    ).toEqual({
      profile: 'ts-sdk',
      minimumPartSize: 10,
      recommendedPartSize: 20,
      strictAuth: true,
      authTokenTtlMs: 1000,
      partnerAuthorize: true,
      partnerApiEnabled: false,
      partnerAccountHasValidPhone: false,
      partnerAccountInGoodStanding: false,
      customUploadTimestampsEnabled: true,
    })
  })

  it('leaves out options that are undefined', () => {
    expect(toResetConfig({ minimumPartSize: undefined } as never)).toEqual(toResetConfig())
  })

  it.each([
    ['onWebhookDeliver', { onWebhookDeliver: () => {} }],
    ['onReplicate', { onReplicate: () => {} }],
    ['onHookError', { onHookError: () => {} }],
    ['partnerGroupsCapabilities', { partnerGroupsCapabilities: ['all'] }],
    ['partnerBackupCapabilities', { partnerBackupCapabilities: ['all'] }],
  ])('refuses %s, which has no standalone equivalent', (name, options) => {
    expect(() => toResetConfig(options as never)).toThrow(
      new RegExp(`${name}.*no standalone simulator equivalent`),
    )
  })

  it('refuses an unknown option instead of ignoring it', () => {
    expect(() => toResetConfig({ notASimulatorOption: 5 } as never)).toThrow(
      /unknown simulator option "notASimulatorOption"/,
    )
  })
})

describe('makeRemoteClient / resetRemoteSimulator (against the standalone server)', () => {
  it('connects a client over HTTP with the mapped options in effect', async () => {
    const { client, sim } = await makeRemoteClient({ minimumPartSize: 10, recommendedPartSize: 20 })
    expect(sim.realm).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await client.authorize()
    expect(client.accountInfo.getAbsoluteMinimumPartSize()).toBe(10)
    expect(client.accountInfo.getRecommendedPartSize()).toBe(20)
  })

  it('accepts the structured { sim, client } call shape', async () => {
    const { client } = await makeRemoteClient({
      sim: { recommendedPartSize: 7_000_000 },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    expect(client.accountInfo.getRecommendedPartSize()).toBe(7_000_000)
  })

  it('starts every client from an empty simulator', async () => {
    const first = await makeRemoteClient()
    await first.client.authorize()
    await first.client.createBucket({
      bucketName: 'reset-check',
      bucketType: BucketType.AllPrivate,
    })
    expect(await first.client.listBuckets()).toHaveLength(1)

    const second = await makeRemoteClient()
    await second.client.authorize()
    expect(await second.client.listBuckets()).toEqual([])
  })

  it('keeps a hand-built client off every origin but the simulator', async () => {
    const sim = await resetRemoteSimulator()
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    // No realm: the client would go to production, which the transport refuses.
    await expect(client.authorize()).rejects.toThrow(/refused https:\/\/api\.backblazeb2\.com/)
  })
})

describe('RemoteSimulator control methods', () => {
  async function authorized(simOptions: Parameters<typeof makeRemoteClient>[0] = {}) {
    const made = await makeRemoteClient({
      sim: simOptions as never,
      client: { retry: { maxRetries: 0 } },
    })
    await made.client.authorize()
    return made
  }

  it('injectFailure fails matching calls with the embedded defaults (503, simulated failure)', async () => {
    const { client, sim } = await authorized()
    await sim.injectFailure({ on: 'b2_list_buckets', count: 1 })
    const error = await client.listBuckets().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(B2Error)
    expect((error as B2Error).status).toBe(503)
    expect((error as B2Error).code).toBe('service_unavailable')
    expect((error as B2Error).message).toContain('simulated failure')
    await expect(client.listBuckets()).resolves.toEqual([])
  })

  it('injectFailure honours status, code, skip and the returned handle', async () => {
    const { client, sim } = await authorized()
    const handle = await sim.injectFailure({
      on: 'b2_list_buckets',
      status: 400,
      code: 'bad_request',
      message: 'nope',
      skip: 1,
    })
    await expect(client.listBuckets()).resolves.toEqual([])
    await expect(client.listBuckets()).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await handle.clear()
    await handle.clear()
    await expect(client.listBuckets()).resolves.toEqual([])
  })

  it('injectFailure refuses a URL fragment and says to use a full endpoint name', async () => {
    const { sim } = await authorized()
    await expect(sim.injectFailure({ on: 'b2_upload_part?fileId=' })).rejects.toThrow(
      /POST \/faults.*full B2 endpoint name/s,
    )
  })

  it('clearFaults removes every injected fault', async () => {
    const { client, sim } = await authorized()
    await sim.injectFailure({ on: 'b2_list_buckets' })
    await sim.clearFaults()
    await expect(client.listBuckets()).resolves.toEqual([])
  })

  it('advanceTime moves the clock so tokens expire and the client reauthorizes', async () => {
    const { client, sim } = await authorized({ strictAuth: true, authTokenTtlMs: 1000 })
    const originalToken = client.accountInfo.getAuthToken()
    await sim.advanceTime(2000)
    await expect(client.listBuckets()).resolves.toEqual([])
    expect(client.accountInfo.getAuthToken()).not.toBe(originalToken)
  })

  it('advanceTime refuses to rewind, which the standalone clock cannot do', async () => {
    const { sim } = await authorized()
    await expect(sim.advanceTime(-1)).rejects.toThrow(/positive integer/)
    await expect(sim.advanceTime(0)).rejects.toThrow(/positive integer/)
  })

  it('expireUploadToken and invalidateUploadToken report whether the token existed', async () => {
    const { client, sim } = await authorized()
    const bucket = await client.createBucket({
      bucketName: 'upload-tokens',
      bucketType: BucketType.AllPrivate,
    })
    const info = client.accountInfo
    const first = await client.raw.getUploadUrl(info.getApiUrl(), info.getAuthToken(), {
      bucketId: bucket.id,
    })
    const second = await client.raw.getUploadUrl(info.getApiUrl(), info.getAuthToken(), {
      bucketId: bucket.id,
    })
    await expect(sim.expireUploadToken(first.authorizationToken)).resolves.toBe(true)
    await expect(sim.invalidateUploadToken(second.authorizationToken)).resolves.toBe(true)
    await expect(sim.expireUploadToken('no-such-token')).resolves.toBe(false)
    await expect(sim.invalidateUploadToken('no-such-token')).resolves.toBe(false)
  })

  it('flushHooks waits for the server to settle', async () => {
    const { sim } = await authorized()
    await expect(sim.flushHooks()).resolves.toBeUndefined()
  })

  it('refuses to drive a simulator that a later reset replaced', async () => {
    const { sim: stale } = await authorized()
    await authorized()
    await expect(stale.injectFailure({ on: 'b2_list_buckets' })).rejects.toThrow(
      /reset by a later makeRemoteClient\/resetRemoteSimulator call/,
    )
  })
})
