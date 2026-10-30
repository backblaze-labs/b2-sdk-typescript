import { Console } from 'node:console'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import type { AccountInfo } from './auth/account-info.ts'
import { FileAccountInfo } from './auth/file.ts'
import { UploadUrlPool } from './auth/index.ts'
import { BackupClient } from './backup/index.ts'
import { DEFAULT_RETRY_OPTIONS } from './http/retry.ts'
import { B2Client, B2Object, Bucket, InMemoryAccountInfo } from './index.ts'
import { InMemoryPartnerAccountInfo, PartnerClient } from './partner/index.ts'
import { B2Simulator } from './simulator/index.ts'
import { jsonResponse } from './test-utils/index.ts'
import {
  CREDENTIAL_BEARING_EXPORTS,
  REVIEWED_EXPORTS,
} from './test-utils/redaction-export-review.ts'
import { BucketType } from './types/bucket.ts'
import { type AuthToken, bucketId, partnerToken } from './types/ids.ts'

const APP_KEY = 'SECRET-APPKEY'
const ACCOUNT_TOKEN = 'SECRET-ACCOUNT-TOKEN'
const UPLOAD_TOKEN = 'SECRET-UPLOAD-TOKEN'
const PART_TOKEN = 'SECRET-PART-UPLOAD-TOKEN'
const SECRETS = [APP_KEY, ACCOUNT_TOKEN, UPLOAD_TOKEN, PART_TOKEN]
const entry = { uploadUrl: 'https://pod.backblaze.com/upload', authorizationToken: UPLOAD_TOKEN }
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(store: AccountInfo = new InMemoryAccountInfo()) {
  const sim = new B2Simulator()
  const seed = new B2Client({
    applicationKeyId: 'key-id',
    applicationKey: APP_KEY,
    transport: sim.transport(),
  })
  const auth = { ...(await seed.authorize()), authorizationToken: ACCOUNT_TOKEN as AuthToken }
  const info = (
    await seed.createBucket({ bucketName: 'diagnostic-bucket', bucketType: BucketType.AllPrivate })
  ).info
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

function consoleOutput(value: unknown): string {
  let output = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk)
      callback()
    },
  })
  new Console({ stdout }).log(value)
  return output
}

const surfaces = [
  ['inspect default', (value: object) => inspect(value)],
  [
    'inspect hidden unlimited',
    (value: object) => inspect(value, { depth: Infinity, showHidden: true }),
  ],
  ['console.log', consoleOutput],
] as const

async function fileStore() {
  const directory = await mkdtemp(join(tmpdir(), 'b2-redaction-'))
  directories.push(directory)
  const path = join(directory, 'auth.json')
  return { path, store: new FileAccountInfo(path) }
}

function poolTokens(store: AccountInfo): void {
  store.returnUploadUrl(bucketId('diagnostic-bucket-id'), entry)
  store.returnPartUploadUrl('large-file-id', { ...entry, authorizationToken: PART_TOKEN })
}

describe('credential redaction Node diagnostics', () => {
  it.each(surfaces)(
    'client summary isolates custom enumerable AccountInfo via %s',
    async (_name, render) => {
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
      const rendered = render(client)
      assertNoSecrets(rendered)
      expect(rendered).toBe(render(client.toJSON()))
    },
  )

  for (const name of ['client', 'bucket', 'object', 'store'] as const) {
    it.each(surfaces)(
      `${name} hides credentials before and after authorization via %s`,
      async (_surface, render) => {
        const value = await fixture()
        for (const authorized of [false, true]) {
          if (authorized) {
            await value.client.authorize()
            poolTokens(value.store)
          }
          assertNoSecrets(render(value[name]))
        }
      },
    )
  }

  it('memory store inspect preserves the exact safe summary before and after setAuth', async () => {
    const { auth, store } = await fixture()
    expect(inspect(store)).toBe(inspect({ authorized: false }))
    store.setAuth(auth)
    poolTokens(store)
    expect(inspect(store)).toBe(inspect({ authorized: true }))
  })

  it('file store inspect preserves the exact safe summary before and after setAuth', async () => {
    const { store } = await fileStore()
    const { auth } = await fixture()
    expect(inspect(store)).toBe(inspect({ authorized: false }))
    store.setAuth(auth)
    poolTokens(store)
    await store.flushed()
    expect(inspect(store)).toBe(inspect({ authorized: true }))
  })

  it.each(surfaces)('direct pool hides upload tokens via %s', (_name, render) => {
    const pool = new UploadUrlPool()
    pool.checkin('bucket', entry)
    pool.checkin('part', { ...entry, authorizationToken: PART_TOKEN })
    assertNoSecrets(render(pool))
  })

  it('file store inner reference is hidden from spread', async () => {
    const { store } = await fileStore()
    const { auth } = await fixture()
    store.setAuth(auth)
    poolTokens(store)
    await store.flushed()
    expect(Object.keys(store)).not.toContain('inner')
    assertNoSecrets(JSON.stringify({ ...store }))
  })

  it('file store JSON preserves a safe authorized summary', async () => {
    const { store } = await fileStore()
    const { auth } = await fixture()
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: false })
    store.setAuth(auth)
    poolTokens(store)
    await store.flushed()
    assertNoSecrets(JSON.stringify(store))
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: true })
    store.clear()
    await store.flushed()
    expect(JSON.parse(JSON.stringify(store))).toEqual({ authorized: false })
  })

  it.each(surfaces)(
    'file store hides credentials before and after authorization via %s',
    async (_name, render) => {
      const { store } = await fileStore()
      const value = await fixture(store)
      assertNoSecrets(render(store))
      await value.client.authorize()
      poolTokens(store)
      await store.flushed()
      assertNoSecrets(render(store))
    },
  )

  it.each([false, true])(
    'file store disk round-trip keeps the real token (bound=%s)',
    async (bound) => {
      const { path, store } = await fileStore()
      const { auth } = await fixture()
      if (bound) {
        store.setRealmUrl('https://api.backblazeb2.com')
        store.setApplicationKeyId('key-id')
      }
      store.setAuth(auth)
      await store.flushed()
      expect(JSON.parse(await readFile(path, 'utf8')).authorizationToken).toBe(ACCOUNT_TOKEN)
      const reloaded = new FileAccountInfo(path)
      if (bound) {
        reloaded.setRealmUrl('https://api.backblazeb2.com')
        reloaded.setApplicationKeyId('key-id')
      }
      await reloaded.load()
      expect(reloaded.getAuth()?.authorizationToken).toBe(ACCOUNT_TOKEN)
      expect(reloaded.getAuthToken()).toBe(ACCOUNT_TOKEN)
      assertNoSecrets(JSON.stringify(reloaded))
    },
  )

  it('reviewed public exports have sentinel coverage on every leak surface', async () => {
    const { store: file } = await fileStore()
    const { auth, client, store, bucket, object } = await fixture()
    store.setAuth(auth)
    file.setAuth(auth)
    poolTokens(store)
    poolTokens(file)
    await file.flushed()
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
    const instances = new Map<unknown, object>([
      [B2Client, client],
      [InMemoryAccountInfo, store],
      [FileAccountInfo, file],
      [UploadUrlPool, pool],
      [Bucket, bucket],
      [B2Object, object],
      [InMemoryPartnerAccountInfo, partnerStore],
      [PartnerClient, partner],
      [BackupClient, backup],
    ])
    const publicExports: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
      '.': await import('./index.ts'),
      './auth': await import('./auth/index.ts'),
      './auth/file': await import('./auth/file.ts'),
      './backup': await import('./backup/index.ts'),
      './errors': await import('./errors/index.ts'),
      './notifications': await import('./notifications/index.ts'),
      './partner': await import('./partner/index.ts'),
      './raw': await import('./raw/index.ts'),
      './s3': await import('./s3/index.ts'),
      './simulator': await import('./simulator/index.ts'),
      './streams': await import('./streams/index.ts'),
      './sync': await import('./sync/index.ts'),
    }
    expect(Object.keys(publicExports).sort()).toEqual(Object.keys(pkg.exports).sort())
    expect(Object.keys(REVIEWED_EXPORTS).sort()).toEqual(Object.keys(pkg.exports).sort())
    const covered: string[] = []
    for (const [path, exports] of Object.entries(publicExports)) {
      expect(Object.keys(exports).sort(), `Exports need review at ${path}`).toEqual(
        REVIEWED_EXPORTS[path],
      )
      for (const [name, exported] of Object.entries(exports)) {
        if (!CREDENTIAL_BEARING_EXPORTS[path]?.includes(name)) continue
        const value = instances.get(exported)
        if (value === undefined) throw new Error(`Missing sentinel fixture for ${path}:${name}`)
        covered.push(`${path}:${name}`)
        for (const [, render] of surfaces) assertNoSecrets(render(value))
        assertNoSecrets(JSON.stringify(value))
        assertNoSecrets(JSON.stringify({ ...value }))
      }
    }
    expect(covered.sort()).toEqual(
      Object.entries(CREDENTIAL_BEARING_EXPORTS)
        .flatMap(([path, names]) => names.map((name) => `${path}:${name}`))
        .sort(),
    )
  })
})
