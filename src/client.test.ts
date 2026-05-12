import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from './client.js'
import { B2Simulator } from './simulator/index.js'
import { BufferSource } from './streams/source.js'
import type { LargeFileId } from './types/ids.js'

function makeClient(): { client: B2Client; sim: B2Simulator } {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.byteLength
  }
  return result
}

describe('B2Client with simulator', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
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

// --- Download tests ---

describe('downloads', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('downloads a file by name', async () => {
    const bucket = await client.createBucket({ bucketName: 'dl-test', bucketType: 'allPrivate' })
    const content = new TextEncoder().encode('download me')
    await bucket.upload({ fileName: 'hello.txt', source: new BufferSource(content) })

    const result = await bucket.download('hello.txt')
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('download me')
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileName).toBe('hello.txt')
  })

  it('downloads a file by id via B2Object', async () => {
    const bucket = await client.createBucket({ bucketName: 'dl-id', bucketType: 'allPrivate' })
    const content = new TextEncoder().encode('by-id content')
    const uploaded = await bucket.upload({
      fileName: 'byid.bin',
      source: new BufferSource(content),
    })

    const obj = bucket.file('byid.bin')
    const result = await obj.downloadById(uploaded.fileId)
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('by-id content')
  })

  it('downloads a range of bytes', async () => {
    const bucket = await client.createBucket({ bucketName: 'dl-range', bucketType: 'allPrivate' })
    const content = new TextEncoder().encode('0123456789abcdef')
    await bucket.upload({ fileName: 'range.bin', source: new BufferSource(content) })

    const result = await bucket.download('range.bin', { range: 'bytes=4-7' })
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('4567')
  })

  it('throws on download of missing file', async () => {
    const bucket = await client.createBucket({ bucketName: 'dl-miss', bucketType: 'allPrivate' })

    await expect(bucket.download('nope.txt')).rejects.toThrow()
  })
})

// --- File operations tests ---

describe('file operations', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('gets file info', async () => {
    const bucket = await client.createBucket({ bucketName: 'info-test', bucketType: 'allPrivate' })
    const data = new TextEncoder().encode('info content')
    const uploaded = await bucket.upload({
      fileName: 'info.txt',
      source: new BufferSource(data),
      contentType: 'text/plain',
    })

    const obj = bucket.file('info.txt')
    const info = await obj.getFileInfo(uploaded.fileId)

    expect(info.fileName).toBe('info.txt')
    expect(info.contentLength).toBe(data.byteLength)
    expect(info.contentType).toBe('text/plain')
    expect(info.fileId).toBe(uploaded.fileId)
  })

  it('hides a file and excludes it from listing', async () => {
    const bucket = await client.createBucket({ bucketName: 'hide-test', bucketType: 'allPrivate' })
    await bucket.upload({
      fileName: 'visible.txt',
      source: new BufferSource(new TextEncoder().encode('see me')),
    })
    await bucket.upload({
      fileName: 'hidden.txt',
      source: new BufferSource(new TextEncoder().encode('now you see me')),
    })

    const hidden = await bucket.hideFile('hidden.txt')
    expect(hidden.action).toBe('hide')
    expect(hidden.fileName).toBe('hidden.txt')

    const listing = await bucket.listFileNames()
    const names = listing.files.map((f) => f.fileName)
    expect(names).toContain('visible.txt')
    expect(names).not.toContain('hidden.txt')
  })

  it('hides a file via B2Object.hide()', async () => {
    const bucket = await client.createBucket({ bucketName: 'obj-hide', bucketType: 'allPrivate' })
    await bucket.upload({
      fileName: 'to-hide.txt',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    const obj = bucket.file('to-hide.txt')
    const result = await obj.hide()
    expect(result.action).toBe('hide')

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(0)
  })

  it('deletes a file version', async () => {
    const bucket = await client.createBucket({ bucketName: 'del-ver', bucketType: 'allPrivate' })
    const uploaded = await bucket.upload({
      fileName: 'delete-me.txt',
      source: new BufferSource(new TextEncoder().encode('bye')),
    })

    await bucket.deleteFileVersion('delete-me.txt', uploaded.fileId)

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(0)
  })

  it('deletes via B2Object.deleteVersion()', async () => {
    const bucket = await client.createBucket({ bucketName: 'obj-del', bucketType: 'allPrivate' })
    const uploaded = await bucket.upload({
      fileName: 'obj-delete.txt',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    const obj = bucket.file('obj-delete.txt')
    await obj.deleteVersion(uploaded.fileId)

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(0)
  })

  it('copies a file within the same bucket', async () => {
    const bucket = await client.createBucket({ bucketName: 'copy-test', bucketType: 'allPrivate' })
    const content = new TextEncoder().encode('copy this')
    const original = await bucket.upload({
      fileName: 'original.txt',
      source: new BufferSource(content),
    })

    const copied = await bucket.copyFile({
      sourceFileId: original.fileId,
      fileName: 'copied.txt',
    })

    expect(copied.fileName).toBe('copied.txt')
    expect(copied.contentLength).toBe(content.byteLength)
    expect(copied.action).toBe('copy')

    const result = await bucket.download('copied.txt')
    const data = await readStream(result.body)
    expect(new TextDecoder().decode(data)).toBe('copy this')
  })

  it('copies a file to a different bucket', async () => {
    const src = await client.createBucket({ bucketName: 'copy-src', bucketType: 'allPrivate' })
    const dest = await client.createBucket({ bucketName: 'copy-dest', bucketType: 'allPrivate' })
    const content = new TextEncoder().encode('cross-bucket')
    const original = await src.upload({
      fileName: 'source.bin',
      source: new BufferSource(content),
    })

    const copied = await src.copyFile({
      sourceFileId: original.fileId,
      fileName: 'destination.bin',
      destinationBucketId: dest.id,
    })

    expect(copied.fileName).toBe('destination.bin')

    const result = await dest.download('destination.bin')
    const data = await readStream(result.body)
    expect(new TextDecoder().decode(data)).toBe('cross-bucket')
  })
})

// --- List file versions tests ---

describe('list file versions', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('lists all versions of a file including hidden', async () => {
    const bucket = await client.createBucket({
      bucketName: 'versions-test',
      bucketType: 'allPrivate',
    })

    await bucket.upload({
      fileName: 'doc.txt',
      source: new BufferSource(new TextEncoder().encode('v1')),
    })
    await bucket.upload({
      fileName: 'doc.txt',
      source: new BufferSource(new TextEncoder().encode('v2')),
    })
    await bucket.hideFile('doc.txt')

    const versions = await bucket.listFileVersions()
    const docVersions = versions.files.filter((f) => f.fileName === 'doc.txt')
    expect(docVersions.length).toBe(3)

    const actions = docVersions.map((v) => v.action)
    expect(actions).toContain('upload')
    expect(actions).toContain('hide')
  })

  it('respects maxFileCount in versions listing', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-page',
      bucketType: 'allPrivate',
    })
    for (let i = 0; i < 5; i++) {
      await bucket.upload({
        fileName: `file-${String(i).padStart(2, '0')}.txt`,
        source: new BufferSource(new TextEncoder().encode(`content-${i}`)),
      })
    }

    const page = await bucket.listFileVersions({ maxFileCount: 2 })
    expect(page.files.length).toBe(2)
    expect(page.nextFileName).toBeTruthy()
  })
})

// --- Update bucket tests ---

describe('update bucket', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('updates bucket type', async () => {
    const bucket = await client.createBucket({
      bucketName: 'update-test',
      bucketType: 'allPrivate',
    })
    expect(bucket.info.bucketType).toBe('allPrivate')

    const updated = await bucket.update({ bucketType: 'allPublic' })
    expect(updated.bucketType).toBe('allPublic')
    expect(updated.revision).toBe(2)
  })

  it('updates bucket info metadata', async () => {
    const bucket = await client.createBucket({
      bucketName: 'meta-update',
      bucketType: 'allPrivate',
    })

    const updated = await bucket.update({
      bucketInfo: { 'cache-control': 'max-age=3600' },
    })
    expect(updated.bucketInfo).toEqual({ 'cache-control': 'max-age=3600' })
  })
})

// --- Large file tests ---

describe('large file operations', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('starts, uploads parts, and finishes a large file', async () => {
    const bucket = await client.createBucket({ bucketName: 'large-test', bucketType: 'allPrivate' })

    const startResp = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'big.bin', contentType: 'application/octet-stream' },
    )
    expect(startResp.fileName).toBe('big.bin')

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: startResp.fileId as unknown as LargeFileId },
    )

    const part1 = new Uint8Array(1024).fill(0xaa)
    const part2 = new Uint8Array(1024).fill(0xbb)

    const p1Resp = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1.byteLength,
        contentSha1: 'sha1-part1',
      },
      part1,
    )
    expect(p1Resp.partNumber).toBe(1)

    const p2Resp = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 2,
        contentLength: part2.byteLength,
        contentSha1: 'sha1-part2',
      },
      part2,
    )
    expect(p2Resp.partNumber).toBe(2)

    const finished = await client.raw.finishLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        fileId: startResp.fileId as unknown as LargeFileId,
        partSha1Array: ['sha1-part1', 'sha1-part2'],
      },
    )
    expect(finished.fileName).toBe('big.bin')
    expect(finished.contentLength).toBe(2048)

    const result = await bucket.download('big.bin')
    const data = await readStream(result.body)
    expect(data.byteLength).toBe(2048)
    expect(data[0]).toBe(0xaa)
    expect(data[1024]).toBe(0xbb)
  })

  it('cancels a large file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'large-cancel',
      bucketType: 'allPrivate',
    })

    const startResp = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'cancelled.bin', contentType: 'application/octet-stream' },
    )

    const cancelResp = await client.raw.cancelLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: startResp.fileId as unknown as LargeFileId },
    )
    expect(cancelResp.fileName).toBe('cancelled.bin')

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files).toHaveLength(0)
  })

  it('lists unfinished large files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'large-list',
      bucketType: 'allPrivate',
    })

    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'pending1.bin', contentType: 'application/octet-stream' },
    )
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'pending2.bin', contentType: 'application/octet-stream' },
    )

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files).toHaveLength(2)
    const names = unfinished.files.map((f) => f.fileName)
    expect(names).toContain('pending1.bin')
    expect(names).toContain('pending2.bin')
  })
})

// --- Download authorization tests ---

describe('download authorization', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('gets a download authorization token', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-auth',
      bucketType: 'allPrivate',
    })

    const auth = await bucket.getDownloadAuthorization('photos/', 3600)
    expect(auth.bucketId).toBe(bucket.id)
    expect(auth.fileNamePrefix).toBe('photos/')
    expect(auth.authorizationToken).toBeTruthy()
  })
})

// --- Listing with prefix/pagination tests ---

describe('listing with prefix and pagination', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('filters files by prefix', async () => {
    const bucket = await client.createBucket({
      bucketName: 'prefix-test',
      bucketType: 'allPrivate',
    })
    await bucket.upload({
      fileName: 'photos/a.jpg',
      source: new BufferSource(new TextEncoder().encode('a')),
    })
    await bucket.upload({
      fileName: 'photos/b.jpg',
      source: new BufferSource(new TextEncoder().encode('b')),
    })
    await bucket.upload({
      fileName: 'docs/readme.md',
      source: new BufferSource(new TextEncoder().encode('readme')),
    })

    const photos = await bucket.listFileNames({ prefix: 'photos/' })
    expect(photos.files).toHaveLength(2)
    expect(photos.files.every((f) => f.fileName.startsWith('photos/'))).toBe(true)

    const docs = await bucket.listFileNames({ prefix: 'docs/' })
    expect(docs.files).toHaveLength(1)
  })

  it('paginates file listing with maxFileCount', async () => {
    const bucket = await client.createBucket({ bucketName: 'page-test', bucketType: 'allPrivate' })
    for (let i = 0; i < 5; i++) {
      await bucket.upload({
        fileName: `file-${String(i).padStart(2, '0')}.txt`,
        source: new BufferSource(new TextEncoder().encode(`c${i}`)),
      })
    }

    const page1 = await bucket.listFileNames({ maxFileCount: 2 })
    expect(page1.files).toHaveLength(2)
    expect(page1.nextFileName).toBe('file-02.txt')

    const page2 = await bucket.listFileNames({
      maxFileCount: 2,
      ...(page1.nextFileName !== null ? { startFileName: page1.nextFileName } : {}),
    })
    expect(page2.files).toHaveLength(2)
    expect(page2.files[0]?.fileName).toBe('file-02.txt')
  })

  it('async generator iterates all pages', async () => {
    const bucket = await client.createBucket({
      bucketName: 'allfiles-test',
      bucketType: 'allPrivate',
    })
    const fileNames: string[] = []
    for (let i = 0; i < 10; i++) {
      const name = `item-${String(i).padStart(2, '0')}.dat`
      fileNames.push(name)
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(`data-${i}`)),
      })
    }

    const collected: string[] = []
    for await (const file of bucket.listAllFiles({ pageSize: 3 })) {
      collected.push(file.fileName)
    }

    expect(collected).toEqual(fileNames)
  })
})

// --- Multiple file versions (overwrite) tests ---

describe('file versioning', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('uploading same name creates new version, download returns latest', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-dl',
      bucketType: 'allPrivate',
    })

    await bucket.upload({
      fileName: 'doc.txt',
      source: new BufferSource(new TextEncoder().encode('version 1')),
    })
    await bucket.upload({
      fileName: 'doc.txt',
      source: new BufferSource(new TextEncoder().encode('version 2')),
    })

    const result = await bucket.download('doc.txt')
    const data = await readStream(result.body)
    expect(new TextDecoder().decode(data)).toBe('version 2')

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(1)
  })

  it('hidden file throws on download', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-hide-dl',
      bucketType: 'allPrivate',
    })

    await bucket.upload({
      fileName: 'secret.txt',
      source: new BufferSource(new TextEncoder().encode('secret data')),
    })
    await bucket.hideFile('secret.txt')

    await expect(bucket.download('secret.txt')).rejects.toThrow()
  })
})

// --- Key management tests ---

describe('key management', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('creates and lists application keys', async () => {
    const { accountId } = await import('./types/ids.js')

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: ['readFiles', 'writeFiles'],
        keyName: 'test-key',
      },
    )

    expect(key.keyName).toBe('test-key')
    expect(key.applicationKeyId).toBeTruthy()
    expect(key.applicationKey).toBeTruthy()
    expect(key.capabilities).toContain('readFiles')
    expect(key.capabilities).toContain('writeFiles')

    const listing = await client.raw.listKeys(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { accountId: accountId(client.accountInfo.getAccountId()) },
    )

    expect(listing.keys.length).toBeGreaterThanOrEqual(1)
    const found = listing.keys.find((k) => k.keyName === 'test-key')
    expect(found).toBeTruthy()
  })

  it('deletes an application key', async () => {
    const { accountId } = await import('./types/ids.js')

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: ['listBuckets'],
        keyName: 'to-delete',
      },
    )

    const deleted = await client.raw.deleteKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { applicationKeyId: key.applicationKeyId },
    )
    expect(deleted.keyName).toBe('to-delete')

    const listing = await client.raw.listKeys(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { accountId: accountId(client.accountInfo.getAccountId()) },
    )
    const found = listing.keys.find((k) => k.keyName === 'to-delete')
    expect(found).toBeUndefined()
  })

  it('creates a key scoped to a bucket', async () => {
    const { accountId } = await import('./types/ids.js')
    const bucket = await client.createBucket({ bucketName: 'key-scope', bucketType: 'allPrivate' })

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: ['readFiles'],
        keyName: 'scoped-key',
        bucketId: bucket.id,
        namePrefix: 'photos/',
      },
    )

    expect(key.bucketId).toBe(bucket.id)
    expect(key.namePrefix).toBe('photos/')
  })
})

// --- Notification rules tests ---

describe('notification rules', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('gets empty notification rules for new bucket', async () => {
    const bucket = await client.createBucket({
      bucketName: 'notif-empty',
      bucketType: 'allPrivate',
    })

    const rules = await bucket.getNotificationRules()
    expect(rules.eventNotificationRules).toEqual([])
    expect(rules.bucketId).toBe(bucket.id)
  })

  it('sets and gets notification rules', async () => {
    const bucket = await client.createBucket({
      bucketName: 'notif-set',
      bucketType: 'allPrivate',
    })

    const rule = {
      eventTypes: ['b2:ObjectCreated:*'] as const,
      isEnabled: true,
      isSuspended: false,
      name: 'upload-webhook',
      objectNamePrefix: 'photos/',
      suspensionReason: '',
      targetConfiguration: {
        targetType: 'webhook',
        url: 'https://example.com/webhook',
      },
    }

    const setResult = await bucket.setNotificationRules([rule])
    expect(setResult.eventNotificationRules).toHaveLength(1)
    expect(setResult.eventNotificationRules[0]?.name).toBe('upload-webhook')

    const getResult = await bucket.getNotificationRules()
    expect(getResult.eventNotificationRules).toHaveLength(1)
    expect(getResult.eventNotificationRules[0]?.targetConfiguration.url).toBe(
      'https://example.com/webhook',
    )
  })

  it('replaces notification rules', async () => {
    const bucket = await client.createBucket({
      bucketName: 'notif-replace',
      bucketType: 'allPrivate',
    })

    await bucket.setNotificationRules([
      {
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: true,
        isSuspended: false,
        name: 'rule-1',
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: { targetType: 'webhook', url: 'https://one.example.com' },
      },
    ])

    await bucket.setNotificationRules([
      {
        eventTypes: ['b2:ObjectDeleted:*'],
        isEnabled: true,
        isSuspended: false,
        name: 'rule-2',
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: { targetType: 'webhook', url: 'https://two.example.com' },
      },
    ])

    const rules = await bucket.getNotificationRules()
    expect(rules.eventNotificationRules).toHaveLength(1)
    expect(rules.eventNotificationRules[0]?.name).toBe('rule-2')
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
