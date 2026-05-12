import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from './client.js'
import { B2Simulator } from './simulator/index.js'
import { BufferSource } from './streams/source.js'

describe('B2Client with simulator', () => {
  let client: B2Client
  let sim: B2Simulator

  beforeEach(async () => {
    sim = new B2Simulator()
    client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
    })
    await client.authorize()
  })

  it('authorizes and stores account info', () => {
    expect(client.accountInfo.getAccountId()).toBe('sim_account_0001')
    expect(client.accountInfo.getRecommendedPartSize()).toBe(100_000_000)
    expect(client.accountInfo.getAbsoluteMinimumPartSize()).toBe(5_000_000)
  })

  it('creates and lists buckets', async () => {
    const bucket = await client.createBucket({
      bucketName: 'test-bucket',
      bucketType: 'allPrivate',
    })

    expect(bucket.name).toBe('test-bucket')
    expect(bucket.id).toBeTruthy()

    const buckets = await client.listBuckets()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.name).toBe('test-bucket')
  })

  it('prevents duplicate bucket names', async () => {
    await client.createBucket({ bucketName: 'my-bucket', bucketType: 'allPrivate' })

    await expect(
      client.createBucket({ bucketName: 'my-bucket', bucketType: 'allPrivate' }),
    ).rejects.toThrow('Bucket name already in use')
  })

  it('deletes a bucket', async () => {
    const bucket = await client.createBucket({
      bucketName: 'to-delete',
      bucketType: 'allPrivate',
    })

    await bucket.delete()

    const buckets = await client.listBuckets()
    expect(buckets).toHaveLength(0)
  })

  it('gets a bucket by name', async () => {
    await client.createBucket({ bucketName: 'find-me', bucketType: 'allPublic' })

    const found = await client.getBucket('find-me')
    expect(found).not.toBeNull()
    expect(found?.name).toBe('find-me')
  })

  it('uploads and lists files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'upload-test',
      bucketType: 'allPrivate',
    })

    const data = new TextEncoder().encode('hello b2 sdk')
    const source = new BufferSource(data)

    const file = await bucket.upload({
      fileName: 'test.txt',
      source,
      contentType: 'text/plain',
    })

    expect(file.fileName).toBe('test.txt')
    expect(file.contentLength).toBe(data.byteLength)
    expect(file.action).toBe('upload')

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(1)
    expect(listing.files[0]?.fileName).toBe('test.txt')
  })

  it('uploads multiple files and iterates with async generator', async () => {
    const bucket = await client.createBucket({
      bucketName: 'multi-test',
      bucketType: 'allPrivate',
    })

    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
    for (const name of names) {
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(name)),
      })
    }

    const collected: string[] = []
    for await (const file of bucket.listAllFiles()) {
      collected.push(file.fileName)
    }

    expect(collected).toEqual(names)
  })

  it('uses B2Object handle for upload', async () => {
    const bucket = await client.createBucket({
      bucketName: 'object-test',
      bucketType: 'allPrivate',
    })

    const obj = bucket.file('docs/readme.md')
    const file = await obj.upload({
      source: new BufferSource(new TextEncoder().encode('# Hello')),
      contentType: 'text/markdown',
    })

    expect(file.fileName).toBe('docs/readme.md')
    expect(file.contentType).toBe('text/markdown')
  })
})

describe('error classification', () => {
  it('classifies expired_auth_token as retryable', async () => {
    const { classifyError } = await import('./errors/index.js')
    const error = classifyError({
      status: 401,
      code: 'expired_auth_token',
      message: 'Token expired',
    })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ExpiredAuthTokenError')
  })

  it('classifies cap_exceeded as not retryable', async () => {
    const { classifyError } = await import('./errors/index.js')
    const error = classifyError({ status: 403, code: 'cap_exceeded', message: 'Cap exceeded' })
    expect(error.retryable).toBe(false)
    expect(error.name).toBe('CapExceededError')
  })

  it('classifies 503 as retryable', async () => {
    const { classifyError } = await import('./errors/index.js')
    const error = classifyError({ status: 503, code: 'service_unavailable', message: 'Try again' })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ServiceUnavailableError')
  })
})

describe('IncrementalSha1', () => {
  it('computes correct SHA1 for known input', async () => {
    const { IncrementalSha1 } = await import('./streams/hash.js')
    const sha1 = new IncrementalSha1()
    await sha1.update(new TextEncoder().encode('hello'))
    const digest = await sha1.digest()
    expect(digest).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })

  it('handles multiple updates', async () => {
    const { IncrementalSha1, sha1Hex } = await import('./streams/hash.js')
    const sha1 = new IncrementalSha1()
    await sha1.update(new TextEncoder().encode('hello'))
    await sha1.update(new TextEncoder().encode(' world'))
    const digest = await sha1.digest()

    const singlePass = await sha1Hex(new TextEncoder().encode('hello world'))
    expect(digest).toBe(singlePass)
  })
})

describe('encoding', () => {
  it('percent-encodes file names correctly', async () => {
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.js')
    expect(encodeFileName('photos/2026/cat.jpg')).toBe('photos/2026/cat.jpg')
    expect(encodeFileName('path with spaces')).toBe('path%20with%20spaces')
    expect(decodeFileName('path%20with%20spaces')).toBe('path with spaces')
  })

  it('handles unicode in file names', async () => {
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.js')
    const original = 'docs/日本語.txt'
    const encoded = encodeFileName(original)
    expect(encoded).not.toContain('日')
    expect(decodeFileName(encoded)).toBe(original)
  })
})
