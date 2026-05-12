import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'
import { FileAccountInfo } from './file.ts'

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
    const bucket = await client.createBucket({
      bucketName: 'pool-delegate',
      bucketType: 'allPrivate',
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
