import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { sha1Hex } from '../streams/hash.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { Capability } from '../types/auth.ts'
import { BucketRetentionMode, BucketType } from '../types/bucket.ts'
import { EncryptionKey, type EncryptionSetting } from '../types/encryption.ts'
import { accountId, applicationKeyId, bucketId, fileId } from '../types/ids.ts'
import { B2Simulator } from './index.ts'

type TokenInternals = {
  signUploadTokenPayload(encodedPayload: string): Promise<string>
  decodeUploadAuthorizationToken(authorizationToken: string): Promise<unknown>
  authorizeScopeGrant(
    scope:
      | {
          bucketIds: readonly string[]
          fileNames?: readonly string[]
          requiresBucketScope: boolean
          requiresAccountLevelBucketAccess?: boolean
        }
      | undefined,
    grant: {
      readonly bucketIds: readonly string[] | null
      readonly namePrefix: string | null
      readonly bucketScopeRequiredMessage: () => string
      readonly bucketMismatchMessage: (bucketId: string) => string
      readonly prefixMismatchMessage: (fileName: string) => string
    },
  ): { status: number; body: unknown } | null
  createKeyCapabilitiesOutsideGrant(
    authToken: string | undefined,
    requested: readonly Capability[],
  ): readonly Capability[]
  createKeyCreatorAccountId(authToken: string | undefined): string
  handleUploadPart(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): Promise<{ status: number; body: unknown }>
  uploadUrlMatches(
    token: {
      kind: 'file' | 'part'
      uploadUrl: string
    },
    uploadUrl: string,
  ): boolean
}

function b2JsonApiUrl(endpoint: string): string {
  return `http://localhost:0/b2api/v4/${endpoint}`
}

function basic(value: string): string {
  return `Basic ${btoa(value)}`
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function signedUploadToken(
  sim: B2Simulator,
  prefix: 'sim_upload_auth' | 'sim_part_auth',
  encodedPayload: string,
): Promise<string> {
  const internals = sim as unknown as TokenInternals
  const signature = await internals.signUploadTokenPayload(encodedPayload)
  return `${prefix}_${encodedPayload}.${signature}`
}

async function postJson(
  sim: B2Simulator,
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return sim.transport().send({
    method: 'POST',
    url: b2JsonApiUrl(endpoint),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function expectJsonError(
  response: Awaited<ReturnType<ReturnType<B2Simulator['transport']>['send']>>,
  status: number,
  code: string,
  message?: RegExp,
): Promise<void> {
  expect(response.status).toBe(status)
  const body = (await response.json()) as { code: string; message: string }
  expect(body.code).toBe(code)
  if (message !== undefined) expect(body.message).toMatch(message)
}

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

async function uploadUrlFixture() {
  const { client, sim } = makeClient({ client: { retry: { maxRetries: 0 } } })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'coverage-upload',
    bucketType: BucketType.AllPrivate,
  })
  const apiUrl = client.accountInfo.getApiUrl()
  const authToken = client.accountInfo.getAuthToken()
  const upload = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
  return { client, sim, bucket, upload }
}

describe('B2Simulator coverage gate: auth parser edges', () => {
  it.each([
    ['invalid base64', 'Basic !!!'],
    ['missing separator', basic('missing-separator')],
    ['missing key id', basic(':secret')],
    ['missing secret', basic('key-id:')],
  ])('rejects malformed Basic authorization: %s', async (_, authorization) => {
    const sim = new B2Simulator()
    const response = await sim.transport().send({
      method: 'GET',
      url: b2JsonApiUrl('b2_authorize_account'),
      headers: { Authorization: authorization },
    })

    await expectJsonError(response, 401, 'unauthorized')
  })
})

describe('B2Simulator coverage gate: bucket configuration edges', () => {
  it.each([
    ['non-object default encryption', { defaultServerSideEncryption: null }, /must be an object/],
    [
      'customer fields in bucket default encryption',
      {
        defaultServerSideEncryption: {
          mode: null,
          algorithm: null,
          customerKey: 'not-allowed',
        },
      },
      /cannot use SSE-C/,
    ],
    [
      'wrong SSE-B2 algorithm',
      {
        defaultServerSideEncryption: {
          mode: 'SSE-B2',
          algorithm: 'AES128',
        },
      },
      /must be AES256/,
    ],
    [
      'unsupported default encryption mode',
      {
        defaultServerSideEncryption: {
          mode: 'not-a-mode',
          algorithm: 'AES256',
        },
      },
      /Unsupported bucket default server-side encryption mode/,
    ],
    ['non-boolean fileLockEnabled', { fileLockEnabled: 'true' }, /must be a boolean/],
  ])('rejects %s', async (name, fields, message) => {
    const sim = new B2Simulator()
    const response = await postJson(sim, 'b2_create_bucket', {
      accountId: 'sim_account_0001',
      bucketName: `bad-${name.replaceAll(' ', '-').slice(0, 45)}`,
      bucketType: BucketType.AllPrivate,
      ...fields,
    })

    await expectJsonError(response, 400, 'bad_request', message)
  })

  it('rejects attempts to disable Object Lock once enabled', async () => {
    const sim = new B2Simulator()
    const created = await postJson(sim, 'b2_create_bucket', {
      accountId: 'sim_account_0001',
      bucketName: 'object-lock-disable',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const bucket = (await created.json()) as { bucketId: string }

    const response = await postJson(sim, 'b2_update_bucket', {
      accountId: 'sim_account_0001',
      bucketId: bucket.bucketId,
      fileLockEnabled: false,
    })

    await expectJsonError(response, 400, 'file_lock_conflict', /cannot be disabled/)
  })

  it('keeps default retention when only fileLockEnabled changes', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'retention-preserved',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
      defaultRetention: {
        mode: BucketRetentionMode.Governance,
        period: { duration: 1, unit: 'days' },
      },
    })

    const updated = await client.raw.updateBucket(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        bucketId: bucket.id,
        fileLockEnabled: true,
      },
    )

    expect(updated.fileLockConfiguration.value?.defaultRetention).toEqual({
      mode: BucketRetentionMode.Governance,
      period: { duration: 1, unit: 'days' },
    })
  })
})

describe('B2Simulator coverage gate: upload parser edges', () => {
  it.each([
    ['non-numeric', 'abc', /must be a byte count/],
    ['unsafe integer', '9007199254740993', /too large/],
  ])('rejects %s Content-Length before reading the body', async (_, contentLength, message) => {
    const { sim, upload } = await uploadUrlFixture()
    const response = await sim.transport().send({
      method: 'POST',
      url: upload.uploadUrl,
      headers: {
        Authorization: upload.authorizationToken,
        'X-Bz-File-Name': 'bad-content-length.txt',
        'X-Bz-Content-Sha1': 'do_not_verify',
        'Content-Type': 'text/plain',
        'Content-Length': contentLength,
      },
      body: new Uint8Array([1]),
    })

    await expectJsonError(response, 400, 'bad_request', message)
  })

  it('rejects unknown upload endpoints passed directly to handleUpload', async () => {
    const sim = new B2Simulator()
    const response = await sim.handleUpload(
      'http://localhost:0/b2api/v4/not_an_upload',
      {},
      new Uint8Array(0),
    )

    expect(response).toMatchObject({
      status: 400,
      body: { code: 'bad_request', message: 'Unknown upload endpoint: not_an_upload' },
    })
  })

  it('rejects hex_digits_at_end uploads shorter than the trailing digest', async () => {
    const { client, upload } = await uploadUrlFixture()

    await expect(
      client.raw.uploadFile(
        upload.uploadUrl,
        {
          authorization: upload.authorizationToken,
          fileName: 'short-trailer.txt',
          contentType: 'text/plain',
          contentLength: 3,
          contentSha1: 'hex_digits_at_end',
        },
        new Uint8Array([1, 2, 3]) as BodyInit,
      ),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it.each([
    ['empty stream', 'empty-stream.txt', []],
    ['single chunk stream', 'single-stream.txt', [new Uint8Array([1])]],
    ['multi chunk stream', 'multi-stream.txt', [new Uint8Array([1]), new Uint8Array([2])]],
  ])('stores an upload body from a %s', async (_, fileName, chunks) => {
    const { sim, upload } = await uploadUrlFixture()
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const response = await sim.transport().send({
      method: 'POST',
      url: upload.uploadUrl,
      headers: {
        Authorization: upload.authorizationToken,
        'X-Bz-File-Name': fileName,
        'X-Bz-Content-Sha1': 'do_not_verify',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(length),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    })

    expect(response.status).toBe(200)
  })

  it('copies Blob upload bodies after checking their declared length', async () => {
    const { sim, upload } = await uploadUrlFixture()
    const response = await sim.transport().send({
      method: 'POST',
      url: upload.uploadUrl,
      headers: {
        Authorization: upload.authorizationToken,
        'X-Bz-File-Name': 'blob-body.txt',
        'X-Bz-Content-Sha1': 'do_not_verify',
        'Content-Type': 'text/plain',
        'Content-Length': '4',
      },
      body: new Blob(['blob']),
    })

    expect(response.status).toBe(200)
  })

  it('rejects malformed part-upload requests at the part handler boundary', async () => {
    const sim = new B2Simulator()
    const internals = sim as unknown as TokenInternals

    await expect(
      internals.handleUploadPart(
        'http://localhost:0/b2api/v4/b2_upload_part',
        {},
        new Uint8Array(0),
      ),
    ).resolves.toMatchObject({ status: 400, body: { message: 'Missing fileId' } })
    await expect(
      internals.handleUploadPart(
        'http://localhost:0/b2api/v4/b2_upload_part?fileId=missing',
        {},
        new Uint8Array(0),
      ),
    ).resolves.toMatchObject({ status: 400, body: { message: 'Large file not found' } })
    ;(
      sim as unknown as {
        readonly largeFiles: Map<string, unknown>
      }
    ).largeFiles.set('large-id', {
      fileId: 'large-id',
      bucketId: 'bucket-id',
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
      fileInfo: {},
      fileRetention: null,
      legalHold: null,
      serverSideEncryption: { mode: 'none' },
      uploadTimestamp: Date.now(),
      parts: new Map(),
    })
    await expect(
      internals.handleUploadPart(
        'http://localhost:0/b2api/v4/b2_upload_part?fileId=large-id',
        {},
        new Uint8Array(0),
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: { message: 'X-Bz-Part-Number header is required' },
    })
    await expect(
      internals.handleUploadPart(
        'http://localhost:0/b2api/v4/b2_upload_part?fileId=large-id',
        { 'x-bz-part-number': 'abc' },
        new Uint8Array(0),
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: {
        message: 'X-Bz-Part-Number must be an integer between 1 and 10000; received abc',
      },
    })
  })

  it('fails closed when comparing malformed upload URLs', () => {
    const sim = new B2Simulator()
    const internals = sim as unknown as TokenInternals

    expect(
      internals.uploadUrlMatches({ kind: 'file', uploadUrl: 'not a url' }, 'http://localhost/u'),
    ).toBe(false)
    expect(
      internals.uploadUrlMatches(
        { kind: 'file', uploadUrl: 'http://localhost:0/b2_upload_file?bucketId=a&uploadId=1' },
        'http://localhost:0/b2_upload_file?bucketId=a&uploadId=2',
      ),
    ).toBe(false)
  })
})

describe('B2Simulator coverage gate: upload token decoder edges', () => {
  it('decodes a signed part-upload token with its file name', async () => {
    const sim = new B2Simulator()
    const expiresAt = Date.now() + 1000
    const payload = base64UrlJson({
      v: 1,
      kind: 'part',
      fileName: 'large.bin',
      uploadUrl: 'http://localhost:0/b2api/v4/b2_upload_part?fileId=large-id',
      namePrefix: 'large/',
      applicationKeyId: 'key-id',
      expiresAt,
    })
    const token = await signedUploadToken(sim, 'sim_part_auth', payload)

    await expect(
      (sim as unknown as TokenInternals).decodeUploadAuthorizationToken(token),
    ).resolves.toMatchObject({
      kind: 'part',
      fileName: 'large.bin',
      namePrefix: 'large/',
      applicationKeyId: 'key-id',
      expiresAt,
    })
  })

  it('fails closed for malformed upload-token signatures and segment counts', async () => {
    const sim = new B2Simulator()
    const payload = base64UrlJson({
      v: 1,
      kind: 'file',
      fileName: null,
      uploadUrl: 'http://localhost:0/b2api/v4/b2_upload_file?bucketId=bucket-id',
      namePrefix: null,
      applicationKeyId: null,
      expiresAt: Date.now() + 1000,
    })
    const internals = sim as unknown as TokenInternals

    await expect(
      internals.decodeUploadAuthorizationToken(`sim_upload_auth_${payload}`),
    ).resolves.toBeNull()
    await expect(
      internals.decodeUploadAuthorizationToken(`sim_upload_auth_${payload}.short-signature`),
    ).resolves.toBeNull()
  })

  it.each([
    ['invalid payload base64', 'sim_upload_auth' as const, '!!!!'],
    ['non-JSON payload', 'sim_upload_auth' as const, btoa('not json')],
    [
      'invalid file-token shape',
      'sim_upload_auth' as const,
      base64UrlJson({
        v: 1,
        kind: 'file',
        fileName: null,
        uploadUrl: 'http://localhost:0/upload',
        namePrefix: null,
        applicationKeyId: null,
        expiresAt: 'not-a-number',
      }),
    ],
    [
      'part token without a file name',
      'sim_part_auth' as const,
      base64UrlJson({
        v: 1,
        kind: 'part',
        fileName: null,
        uploadUrl: 'http://localhost:0/upload',
        namePrefix: null,
        applicationKeyId: null,
        expiresAt: Date.now() + 1000,
      }),
    ],
    [
      'file token with a file name',
      'sim_upload_auth' as const,
      base64UrlJson({
        v: 1,
        kind: 'file',
        fileName: 'unexpected.txt',
        uploadUrl: 'http://localhost:0/upload',
        namePrefix: null,
        applicationKeyId: null,
        expiresAt: Date.now() + 1000,
      }),
    ],
  ])('fails closed for a signed malformed %s', async (_, prefix, payload) => {
    const sim = new B2Simulator()
    const token = await signedUploadToken(sim, prefix, payload)

    await expect(
      (sim as unknown as TokenInternals).decodeUploadAuthorizationToken(token),
    ).resolves.toBeNull()
  })
})

describe('B2Simulator coverage gate: strict-auth scopes', () => {
  it('rejects missing and unknown strict-auth tokens', async () => {
    const sim = new B2Simulator({ strictAuth: true })
    const missing = await postJson(sim, 'b2_list_buckets', { accountId: 'sim_account_0001' })
    await expectJsonError(missing, 401, 'bad_auth_token', /missing/)

    const unknown = await postJson(
      sim,
      'b2_list_buckets',
      { accountId: 'sim_account_0001' },
      { Authorization: 'not-issued' },
    )
    await expectJsonError(unknown, 401, 'bad_auth_token', /unknown/)
  })

  it('rejects strict-auth tokens whose backing key was deleted', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'deleted-token-key',
    })
    const scoped = await authorizeWithKey(sim, key)
    ;(
      sim as unknown as {
        readonly keys: Map<string, unknown>
      }
    ).keys.delete(key.applicationKeyId)

    const response = await postJson(
      sim,
      'b2_list_buckets',
      { accountId: client.accountInfo.getAccountId() },
      { Authorization: scoped.accountInfo.getAuthToken() },
    )

    await expectJsonError(response, 401, 'bad_auth_token', /deleted/)
  })

  it('rejects strict-auth requests missing a required capability', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'missing-capability-key',
    })
    const scoped = await authorizeWithKey(sim, key)

    const response = await postJson(
      sim,
      'b2_list_buckets',
      { accountId: client.accountInfo.getAccountId() },
      { Authorization: scoped.accountInfo.getAuthToken() },
    )

    await expectJsonError(response, 403, 'unauthorized', /lacks required capabilities/)
  })

  it('authorizes bucket-name list scopes against scoped keys', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'bucket-name-scope',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'bucket-name-scope-key',
      bucketIds: [bucket.id],
    })
    const scoped = await authorizeWithKey(sim, key)

    await expect(scoped.listBuckets({ bucketName: bucket.name })).resolves.toHaveLength(1)
  })

  it('rejects unknown Basic credentials in strict mode instead of granting fallback access', async () => {
    const sim = new B2Simulator({ strictAuth: true })
    const response = await sim.transport().send({
      method: 'GET',
      url: b2JsonApiUrl('b2_authorize_account'),
      headers: { Authorization: basic('unknown-key:unknown-secret') },
    })

    await expectJsonError(response, 401, 'unauthorized')
  })

  it('derives direct file-name scope for strict-auth file-version requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.WriteFileRetentions],
      keyName: 'file-name-scope-key',
      namePrefix: 'allowed/',
    })
    const scoped = await authorizeWithKey(sim, key)

    const response = await postJson(
      sim,
      'b2_update_file_retention',
      {
        fileName: 'blocked/file.txt',
        fileId: 'missing-file',
        fileRetention: { mode: null, retainUntilTimestamp: null },
      },
      { Authorization: scoped.accountInfo.getAuthToken() },
    )

    await expectJsonError(response, 403, 'unauthorized', /outside scope/)
  })

  it('covers strict-auth scope grant boundary combinations', () => {
    const sim = new B2Simulator()
    const internals = sim as unknown as TokenInternals
    const grant = {
      bucketIds: ['allowed-bucket'],
      namePrefix: 'allowed/',
      bucketScopeRequiredMessage: () => 'bucket required',
      bucketMismatchMessage: (bucketId: string) => `bad bucket: ${bucketId}`,
      prefixMismatchMessage: (fileName: string) => `bad file: ${fileName}`,
    }

    expect(
      internals.authorizeScopeGrant({ bucketIds: [], requiresBucketScope: true }, grant),
    ).toMatchObject({ status: 403, body: { message: 'bucket required' } })
    expect(
      internals.authorizeScopeGrant(
        {
          bucketIds: ['allowed-bucket'],
          fileNames: ['allowed/file.txt'],
          requiresBucketScope: false,
        },
        grant,
      ),
    ).toBeNull()
    expect(
      internals.authorizeScopeGrant(undefined, {
        ...grant,
        bucketIds: null,
      }),
    ).toBeNull()
  })

  it('calculates delegated key capability gaps from the creator grant', async () => {
    const openSim = new B2Simulator()
    expect(
      (openSim as unknown as TokenInternals).createKeyCapabilitiesOutsideGrant(undefined, [
        Capability.ListBuckets,
      ]),
    ).toEqual([])

    const strictSim = new B2Simulator({ strictAuth: true })
    expect(
      (strictSim as unknown as TokenInternals).createKeyCapabilitiesOutsideGrant(undefined, [
        Capability.ListBuckets,
      ]),
    ).toEqual([Capability.ListBuckets])

    const { client, sim } = makeClient()
    await client.authorize()
    const internals = sim as unknown as TokenInternals
    expect(
      internals.createKeyCapabilitiesOutsideGrant(client.accountInfo.getAuthToken(), [
        Capability.ListBuckets,
      ]),
    ).toEqual([])

    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'delegated-capability-gaps',
    })
    const scoped = await authorizeWithKey(sim, key)
    expect(
      internals.createKeyCapabilitiesOutsideGrant(scoped.accountInfo.getAuthToken(), [
        Capability.ListBuckets,
        Capability.WriteFiles,
      ]),
    ).toEqual([Capability.WriteFiles])
    expect(internals.createKeyCreatorAccountId(scoped.accountInfo.getAuthToken())).toBe(
      client.accountInfo.getAccountId(),
    )
  })
})

describe('B2Simulator coverage gate: download authorization edges', () => {
  async function strictDownloadFixture() {
    const { client, sim } = makeClient({
      sim: { strictAuth: true },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-edge',
      bucketType: BucketType.AllPrivate,
    })
    const otherBucket = await client.createBucket({
      bucketName: 'download-auth-other',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'allowed/file.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const downloadAuth = await client.raw.getDownloadAuthorization(apiUrl, authToken, {
      bucketId: bucket.id,
      fileNamePrefix: 'allowed/',
      validDurationInSeconds: 60,
    })
    return { client, sim, bucket, otherBucket, uploaded, downloadAuth }
  }

  it('rejects download authorization tokens on download-by-id routes', async () => {
    const { sim, uploaded, downloadAuth } = await strictDownloadFixture()
    const response = await sim.transport().send({
      method: 'GET',
      url: `http://localhost:0/b2api/v4/b2_download_file_by_id?fileId=${uploaded.fileId}`,
      headers: { Authorization: downloadAuth.authorizationToken },
    })

    await expectJsonError(response, 403, 'unauthorized', /cannot be used/)
  })

  it('rejects download authorization tokens outside their bucket scope', async () => {
    const { sim, otherBucket, downloadAuth } = await strictDownloadFixture()
    const response = await sim.transport().send({
      method: 'GET',
      url: `http://localhost:0/file/${otherBucket.name}/allowed/file.txt`,
      headers: { Authorization: downloadAuth.authorizationToken },
    })

    await expectJsonError(response, 403, 'unauthorized', /scoped to bucket/)
  })

  it('accepts download authorization tokens from the query string', async () => {
    const { sim, bucket, downloadAuth } = await strictDownloadFixture()
    const response = await sim.transport().send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/file.txt?Authorization=${downloadAuth.authorizationToken}`,
    })

    expect(response.status).toBe(200)
  })

  it('rejects expired download authorization tokens and purges them', async () => {
    const { client, sim, bucket } = await strictDownloadFixture()
    const downloadAuth = await client.raw.getDownloadAuthorization(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 1,
      },
    )

    sim.advanceTime(1000)
    const response = await sim.transport().send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/file.txt`,
      headers: { Authorization: downloadAuth.authorizationToken },
    })

    await expectJsonError(response, 401, 'expired_auth_token', /expired/)
  })

  it('retries download authorization token generation after a collision', async () => {
    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    if (originalCryptoDescriptor === undefined) {
      throw new Error('global crypto must be available')
    }
    const originalCrypto = globalThis.crypto
    let calls = 0
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        subtle: originalCrypto.subtle,
        getRandomValues(bytes: Uint8Array) {
          const fill = calls < 2 ? 1 : calls
          calls += 1
          bytes.fill(fill)
          return bytes
        },
      } as Crypto,
    })
    try {
      const { client, bucket } = await strictDownloadFixture()
      const apiUrl = client.accountInfo.getApiUrl()
      const authToken = client.accountInfo.getAuthToken()
      const first = await client.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
      })
      const second = await client.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
      })

      expect(second.authorizationToken).not.toBe(first.authorizationToken)
      expect(calls).toBe(4)
    } finally {
      Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
    }
  })

  it('surfaces non-JSON download bodies through text and arrayBuffer readers', async () => {
    const { sim, bucket, downloadAuth } = await strictDownloadFixture()
    const response = await sim.transport().send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/file.txt?b2ContentType=text/plain`,
      headers: { Authorization: downloadAuth.authorizationToken },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).rejects.toThrow(/not JSON/)
    await expect(response.text()).resolves.toBe('\u0001\u0002\u0003')
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 3)
    expect(response.headers.get('Content-Type')).toBe('text/plain')
  })

  it('exercises satisfiable, malformed, and unsatisfiable byte ranges', async () => {
    const { client, sim, bucket } = await strictDownloadFixture()
    await bucket.upload({
      fileName: 'allowed/empty.txt',
      source: new BufferSource(new Uint8Array(0)),
    })
    const authToken = client.accountInfo.getAuthToken()

    const suffix = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=-2' },
      'GET',
    )
    expect(suffix.status).toBe(206)
    expect(suffix.headers['Content-Range']).toBe('bytes 1-2/3')

    const openEnded = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=1-' },
      'GET',
    )
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers['Content-Range']).toBe('bytes 1-2/3')

    const malformed = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=-0' },
      'GET',
    )
    expect(malformed.status).toBe(200)
    expect(malformed.headers['Content-Range']).toBeUndefined()

    const missingBounds = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=-' },
      'GET',
    )
    expect(missingBounds.status).toBe(200)
    expect(missingBounds.headers['Content-Range']).toBeUndefined()

    const invertedBounds = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=2-1' },
      'GET',
    )
    expect(invertedBounds.status).toBe(200)
    expect(invertedBounds.headers['Content-Range']).toBeUndefined()

    const pastEnd = sim.handleDownload(
      `/file/${bucket.name}/allowed/file.txt`,
      { authorization: authToken, range: 'bytes=3-4' },
      'GET',
    )
    expect(pastEnd.status).toBe(416)
    expect(pastEnd.headers['Content-Range']).toBe('bytes */3')

    const emptyUnsatisfiable = sim.handleDownload(
      `/file/${bucket.name}/allowed/empty.txt`,
      { authorization: authToken, range: 'bytes=0-0' },
      'GET',
    )
    expect(emptyUnsatisfiable.status).toBe(416)
    expect(emptyUnsatisfiable.headers['Content-Range']).toBe('bytes */0')
  })

  it('marks SSE-C download encryption metadata unreadable without read-encryption scope', async () => {
    const { client, sim } = makeClient({
      sim: { strictAuth: true },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'sse-c-download-redaction',
      bucketType: BucketType.AllPrivate,
    })
    const key = await EncryptionKey.fromBytes(new Uint8Array(32).fill(3))
    const sseC: EncryptionSetting = {
      mode: key.mode,
      algorithm: key.algorithm,
      customerKey: key.customerKey,
      customerKeyMd5: key.customerKeyMd5,
    }
    await bucket.upload({
      fileName: 'secret.txt',
      source: new BufferSource(new Uint8Array([1])),
      serverSideEncryption: sseC,
    })
    const readKey = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'read-no-encryption-key',
      bucketIds: [bucket.id],
    })
    const scoped = await authorizeWithKey(sim, readKey)

    const response = sim.handleDownload(
      `/file/${bucket.name}/secret.txt`,
      {
        authorization: scoped.accountInfo.getAuthToken(),
        'x-bz-server-side-encryption-customer-algorithm': key.algorithm,
        'x-bz-server-side-encryption-customer-key': key.customerKey,
        'x-bz-server-side-encryption-customer-key-md5': key.customerKeyMd5,
      },
      'GET',
    )

    expect(response.status).toBe(200)
    expect(response.headers['X-Bz-Client-Unauthorized-To-Read']).toContain(
      'X-Bz-Server-Side-Encryption-Customer-Algorithm',
    )
  })

  it('returns a 404 download shape for unknown paths', () => {
    const sim = new B2Simulator()

    expect(sim.handleDownload('/not-a-download-route', {})).toEqual({
      status: 404,
      headers: {},
      data: null,
    })
  })
})

describe('B2Simulator coverage gate: hook dispatch edges', () => {
  it('dispatches replication hooks and lets flushHooks await pending work', async () => {
    const replicated: string[] = []
    const { client, sim } = makeClient({
      sim: {
        onReplicate: async ({ sourceFileVersion, destinationBucketId }) => {
          await Promise.resolve()
          replicated.push(`${sourceFileVersion.fileName}:${destinationBucketId}`)
        },
      },
    })
    await client.authorize()
    const destination = await client.createBucket({
      bucketName: 'replication-hook-dest',
      bucketType: BucketType.AllPrivate,
    })
    const source = await client.createBucket({
      bucketName: 'replication-hook-source',
      bucketType: BucketType.AllPrivate,
      replicationConfiguration: {
        asReplicationDestination: null,
        asReplicationSource: {
          sourceApplicationKeyId: applicationKeyId('source-key-id'),
          replicationRules: [
            {
              destinationBucketId: destination.id,
              fileNamePrefix: 'rep/',
              includeExistingFiles: false,
              isEnabled: true,
              priority: 1,
              replicationRuleName: 'replicate-prefix',
            },
          ],
        },
      },
    })

    await source.upload({
      fileName: 'rep/file.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    await sim.flushHooks()

    expect(replicated).toEqual([`rep/file.txt:${destination.id}`])
  })

  it('matches exact webhook event types and exposes fault response readers', async () => {
    const delivered: string[] = []
    let releaseHook: (() => void) | undefined
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: async ({ fileVersion }) => {
          delivered.push(`started:${fileVersion.fileName}`)
          await hookGate
          delivered.push(`finished:${fileVersion.fileName}`)
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'webhook-exact-event',
      bucketType: BucketType.AllPrivate,
    })
    await client.raw.setBucketNotificationRules(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        eventNotificationRules: [
          {
            eventTypes: ['b2:ObjectCreated:Upload'],
            isEnabled: true,
            isSuspended: false,
            name: 'exact-upload',
            objectNamePrefix: '',
            suspensionReason: '',
            targetConfiguration: {
              targetType: 'webhook',
              url: 'https://example.com/hook',
              hmacSha256SigningSecret: 'secret',
            },
          },
        ],
      },
    )
    await bucket.upload({
      fileName: 'exact.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    const flush = sim.flushHooks()
    await Promise.resolve()

    expect(delivered).toEqual(['started:exact.txt'])
    expect(releaseHook).toBeTypeOf('function')
    releaseHook?.()
    await flush

    expect(delivered).toEqual(['started:exact.txt', 'finished:exact.txt'])

    sim.injectFailure({ on: 'b2_list_buckets', message: 'fault-reader' })
    const fault = await sim.transport().send({
      method: 'POST',
      url: b2JsonApiUrl('b2_list_buckets'),
      body: JSON.stringify({ accountId: client.accountInfo.getAccountId() }),
    })
    await expect(fault.text()).resolves.toContain('fault-reader')
    await expect(fault.arrayBuffer()).resolves.toHaveProperty('byteLength')
  })
})

describe('B2Simulator coverage gate: copy and encryption edges', () => {
  it('rejects default SSE-C copy destinations without matching customer encryption', async () => {
    const { client } = makeClient({
      sim: { minimumPartSize: 2, recommendedPartSize: 2 },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-sse-c-edge',
      bucketType: BucketType.AllPrivate,
    })
    const source = await bucket.upload({
      fileName: 'source.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
    })
    const key = await EncryptionKey.fromBytes(new Uint8Array(32).fill(1))
    const sseC: EncryptionSetting = {
      mode: key.mode,
      algorithm: key.algorithm,
      customerKey: key.customerKey,
      customerKeyMd5: key.customerKeyMd5,
    }

    const large = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'dest.txt',
        contentType: 'text/plain',
        serverSideEncryption: sseC,
      },
    )

    await expect(
      client.raw.copyPart(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
        sourceFileId: source.fileId,
        largeFileId: fileId(large.fileId),
        partNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('rejects copy-part destination encryption that does not match the large file', async () => {
    const { client } = makeClient({
      sim: { minimumPartSize: 2, recommendedPartSize: 2 },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-part-sse-c-mismatch',
      bucketType: BucketType.AllPrivate,
    })
    const source = await bucket.upload({
      fileName: 'source.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
    })
    const expectedKey = await EncryptionKey.fromBytes(new Uint8Array(32).fill(4))
    const suppliedKey = await EncryptionKey.fromBytes(new Uint8Array(32).fill(5))
    const expected: EncryptionSetting = {
      mode: expectedKey.mode,
      algorithm: expectedKey.algorithm,
      customerKey: expectedKey.customerKey,
      customerKeyMd5: expectedKey.customerKeyMd5,
    }
    const supplied: EncryptionSetting = {
      mode: suppliedKey.mode,
      algorithm: suppliedKey.algorithm,
      customerKey: suppliedKey.customerKey,
      customerKeyMd5: suppliedKey.customerKeyMd5,
    }
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'dest.txt',
      contentType: 'text/plain',
      serverSideEncryption: expected,
    })

    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileId(large.fileId),
        partNumber: 1,
        destinationServerSideEncryption: supplied,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('rejects a too-short non-final multipart part at finish time', async () => {
    const { client } = makeClient({
      sim: { minimumPartSize: 3, recommendedPartSize: 3 },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'finish-small-part',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'parts.bin',
      contentType: 'application/octet-stream',
    })
    const uploadPart = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })
    const part1 = new Uint8Array([1])
    const part2 = new Uint8Array([2, 3, 4])
    const part1Sha1 = await sha1Hex(part1)
    const part2Sha1 = await sha1Hex(part2)
    await client.raw.uploadPart(
      uploadPart.uploadUrl,
      {
        authorization: uploadPart.authorizationToken,
        partNumber: 1,
        contentLength: part1.byteLength,
        contentSha1: part1Sha1,
      },
      part1 as BodyInit,
    )
    await client.raw.uploadPart(
      uploadPart.uploadUrl,
      {
        authorization: uploadPart.authorizationToken,
        partNumber: 2,
        contentLength: part2.byteLength,
        contentSha1: part2Sha1,
      },
      part2 as BodyInit,
    )

    await expect(
      client.raw.finishLargeFile(apiUrl, authToken, {
        fileId: large.fileId,
        partSha1Array: [part1Sha1, part2Sha1],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })
})

describe('B2Simulator coverage gate: JSON endpoint edges', () => {
  it('parses JSON requests supplied as BodyInit objects', async () => {
    const sim = new B2Simulator()
    const response = await sim.transport().send({
      method: 'POST',
      url: b2JsonApiUrl('b2_create_bucket'),
      headers: { 'Content-Type': 'application/json' },
      body: new Blob([
        JSON.stringify({
          accountId: 'sim_account_0001',
          bucketName: 'blob-json-body',
          bucketType: BucketType.AllPrivate,
        }),
      ]),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ bucketName: 'blob-json-body' })
  })

  it('routes unknown endpoints after preserving malformed request bodies as text', async () => {
    const sim = new B2Simulator()
    const response = await sim.transport().send({
      method: 'POST',
      url: b2JsonApiUrl('b2_not_real'),
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    })

    await expectJsonError(response, 400, 'bad_request', /Unknown endpoint/)
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength')
  })

  it('handles paths with no endpoint segment as unknown routes', async () => {
    const sim = new B2Simulator()
    const response = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    await expectJsonError(response, 400, 'bad_request', /Unknown endpoint/)
  })

  it('covers common missing-resource JSON error branches', async () => {
    const sim = new B2Simulator()
    const missingBucket = { bucketId: 'missing-bucket' }

    await expectJsonError(
      await postJson(sim, 'b2_delete_bucket', missingBucket),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_update_bucket', missingBucket),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_get_upload_url', missingBucket),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_list_file_names', missingBucket),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_list_file_versions', missingBucket),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_get_file_info', { fileId: 'missing-file' }),
      404,
      'file_not_present',
    )
    await expectJsonError(
      await postJson(sim, 'b2_hide_file', { ...missingBucket, fileName: 'x.txt' }),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_get_upload_part_url', { fileId: 'missing-large' }),
      400,
      'bad_request',
    )
    await expectJsonError(
      await postJson(sim, 'b2_finish_large_file', {
        fileId: 'missing-large',
        partSha1Array: [],
      }),
      400,
      'bad_request',
    )
    await expectJsonError(
      await postJson(sim, 'b2_cancel_large_file', { fileId: 'missing-large' }),
      400,
      'bad_request',
    )
    await expectJsonError(
      await postJson(sim, 'b2_list_parts', { fileId: 'missing-large' }),
      400,
      'bad_request',
    )
    await expectJsonError(
      await postJson(sim, 'b2_get_download_authorization', {
        bucketId: 'missing-bucket',
        fileNamePrefix: '',
        validDurationInSeconds: 60,
      }),
      400,
      'bad_bucket_id',
    )
    await expectJsonError(
      await postJson(sim, 'b2_delete_key', { applicationKeyId: 'missing-key' }),
      400,
      'bad_request',
    )
    await expectJsonError(
      await postJson(sim, 'b2_get_bucket_notification_rules', missingBucket),
      400,
      'bad_bucket_id',
    )
  })

  it('covers bucket update guards and hide-file version insertion branches', async () => {
    const sim = new B2Simulator()
    const created = await postJson(sim, 'b2_create_bucket', {
      accountId: 'sim_account_0001',
      bucketName: 'json-edge-bucket',
      bucketType: BucketType.AllPrivate,
    })
    const bucket = (await created.json()) as { bucketId: string }

    await expectJsonError(
      await postJson(sim, 'b2_update_bucket', {
        bucketId: bucket.bucketId,
        ifRevisionIs: '1',
      }),
      400,
      'bad_request',
      /ifRevisionIs/,
    )
    await expectJsonError(
      await postJson(sim, 'b2_update_bucket', {
        bucketId: bucket.bucketId,
        ifRevisionIs: 99,
      }),
      409,
      'conflict',
    )

    const firstHide = await postJson(sim, 'b2_hide_file', {
      bucketId: bucket.bucketId,
      fileName: 'hidden.txt',
    })
    expect(firstHide.status).toBe(200)
    const secondHide = await postJson(sim, 'b2_hide_file', {
      bucketId: bucket.bucketId,
      fileName: 'hidden.txt',
    })
    expect(secondHide.status).toBe(200)
  })

  it('covers file listing pagination and delimiter branches', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'list-edge-bucket',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({ fileName: 'a/one.txt', source: new BufferSource(new Uint8Array([1])) })
    await bucket.upload({ fileName: 'z.txt', source: new BufferSource(new Uint8Array([2])) })

    await expect(
      client.raw.listFileNames(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
        bucketId: bucket.id,
        delimiter: '/',
        maxFileCount: 1,
      }),
    ).resolves.toMatchObject({ nextFileName: 'z.txt' })

    const emptyVersionPage = await client.raw.listFileVersions(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        startFileName: 'zzzz',
      },
    )
    expect(emptyVersionPage.files).toEqual([])
  })

  it('covers copy-file validation and replacement metadata branches', async () => {
    const { client } = makeClient({ client: { retry: { maxRetries: 0 } } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-edge-bucket',
      bucketType: BucketType.AllPrivate,
    })
    const source = await bucket.upload({
      fileName: 'source.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()

    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: fileId('missing-file'),
        fileName: 'copy.txt',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'file_not_present' })
    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: source.fileId,
        destinationBucketId: bucketId('missing-bucket'),
        fileName: 'copy.txt',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_bucket_id' })
    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: source.fileId,
        fileName: 'copy.txt',
        range: 'bytes=bad',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: source.fileId,
        fileName: 'copy.txt',
        range: 'bytes=99-100',
      }),
    ).rejects.toMatchObject({ status: 416, code: 'range_not_satisfiable' })
    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: source.fileId,
        fileName: 'copy.txt',
        metadataDirective: 'REPLACE',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      client.raw.copyFile(apiUrl, authToken, {
        sourceFileId: source.fileId,
        fileName: 'copy.txt',
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    await client.raw.copyFile(apiUrl, authToken, {
      sourceFileId: source.fileId,
      fileName: 'copy.txt',
    })
    const copiedAgain = await client.raw.copyFile(apiUrl, authToken, {
      sourceFileId: source.fileId,
      fileName: 'copy.txt',
    })
    expect(copiedAgain.fileName).toBe('copy.txt')
  })

  it('covers large-file listing, part listing, and copy-part edge branches', async () => {
    const { client } = makeClient({
      sim: { minimumPartSize: 2, recommendedPartSize: 2 },
      client: { retry: { maxRetries: 0 } },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'large-edge-bucket',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const source = await bucket.upload({
      fileName: 'source.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
    })
    const first = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'a-large.bin',
      contentType: 'application/octet-stream',
    })
    const second = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'b-large.bin',
      contentType: 'application/octet-stream',
    })

    await expect(
      client.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucketId('missing-bucket'),
        fileName: 'missing.bin',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_bucket_id' })
    await expect(
      client.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucket.id,
        fileName: '',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
        bucketId: bucket.id,
        maxFileCount: 0,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      startFileId: first.fileId,
      maxFileCount: 1,
    })
    expect(unfinished.files[0]?.fileId).toBe(first.fileId)
    expect(unfinished.nextFileId).toBe(second.fileId)

    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileId('missing-large'),
        partNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileId(first.fileId),
        partNumber: 0,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: fileId('missing-file'),
        largeFileId: fileId(first.fileId),
        partNumber: 1,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'file_not_present' })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileId(first.fileId),
        partNumber: 1,
        range: 'bytes=bad',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileId(first.fileId),
        partNumber: 1,
        range: 'bytes=99-100',
      }),
    ).rejects.toMatchObject({ status: 416, code: 'range_not_satisfiable' })

    const part = await client.raw.copyPart(apiUrl, authToken, {
      sourceFileId: source.fileId,
      largeFileId: fileId(first.fileId),
      partNumber: 1,
      range: 'bytes=0-1',
    })
    expect(part.contentLength).toBe(2)
    await client.raw.copyPart(apiUrl, authToken, {
      sourceFileId: source.fileId,
      largeFileId: fileId(first.fileId),
      partNumber: 2,
      range: 'bytes=2-3',
    })
    const listedParts = await client.raw.listParts(apiUrl, authToken, {
      fileId: first.fileId,
      maxPartCount: 1,
    })
    expect(listedParts.parts).toHaveLength(1)
    expect(listedParts.nextPartNumber).toBe(2)
    await expect(
      client.raw.finishLargeFile(apiUrl, authToken, {
        fileId: first.fileId,
        partSha1Array: [],
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('covers key pagination and scoped upload-token invalidation on delete', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'key-edge-bucket',
      bucketType: BucketType.AllPrivate,
    })
    const writeKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'write-edge-key',
      bucketIds: [bucket.id],
    })
    await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'list-edge-key',
    })
    const scoped = await authorizeWithKey(sim, writeKey)
    const upload = await scoped.raw.getUploadUrl(
      scoped.accountInfo.getApiUrl(),
      scoped.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
      },
    )

    const keys = await client.raw.listKeys(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        maxKeyCount: 1,
      },
    )
    expect(keys.nextApplicationKeyId).toBeTruthy()

    await client.deleteKey(writeKey.applicationKeyId)
    await expect(
      scoped.raw.uploadFile(
        upload.uploadUrl,
        {
          authorization: upload.authorizationToken,
          fileName: 'after-delete.txt',
          contentType: 'text/plain',
          contentLength: 1,
          contentSha1: 'do_not_verify',
        },
        new Uint8Array([1]) as BodyInit,
      ),
    ).rejects.toMatchObject({ status: 401, code: 'bad_auth_token' })
    expect(sim.invalidateUploadToken('not-a-real-token')).toBe(false)
  })

  it('covers file-lock update not-found branches', async () => {
    const sim = new B2Simulator()

    await expectJsonError(
      await postJson(sim, 'b2_update_file_retention', {
        fileName: 'missing.txt',
        fileId: 'missing-file',
        fileRetention: { mode: null, retainUntilTimestamp: null },
      }),
      404,
      'file_not_present',
    )
    await expectJsonError(
      await postJson(sim, 'b2_update_file_legal_hold', {
        fileName: 'missing.txt',
        fileId: 'missing-file',
        legalHold: 'off',
      }),
      404,
      'file_not_present',
    )
  })

  it('rejects Blob upload bodies whose size violates Content-Length', async () => {
    const { sim, upload } = await uploadUrlFixture()
    const response = await sim.transport().send({
      method: 'POST',
      url: upload.uploadUrl,
      headers: {
        Authorization: upload.authorizationToken,
        'X-Bz-File-Name': 'blob-mismatch.txt',
        'X-Bz-Content-Sha1': 'do_not_verify',
        'Content-Type': 'text/plain',
        'Content-Length': '5',
      },
      body: new Blob(['blob']),
    })

    await expectJsonError(response, 400, 'bad_request', /Content-Length/)
  })
})
