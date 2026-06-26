/**
 * Coverage tests for B2Object, B2Client, and Bucket methods that are
 * not exercised by client.test.ts. Each test uses the in-memory
 * B2Simulator so no network I/O is needed.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { B2Client } from './client.ts'
import { BufferSource } from './streams/source.ts'
import { makeClient, readStream } from './test-utils/index.ts'
import { Capability } from './types/auth.ts'
import { BucketType } from './types/bucket.ts'

// ---------------------------------------------------------------------------
// B2Object - coverage for downloadById, getFileInfo, hide, deleteVersion
// ---------------------------------------------------------------------------

describe('B2Object coverage', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('downloadById returns the correct file content', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-dl-id',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('download-by-id-body')
    const uploaded = await bucket.upload({
      fileName: 'target.bin',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const obj = bucket.file('target.bin')
    const result = await obj.downloadById(uploaded.fileId)
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('download-by-id-body')
    expect(result.headers.contentLength).toBe(content.byteLength)
  })

  it('getFileInfo returns metadata matching the upload', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-info',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('info payload')
    const uploaded = await bucket.upload({
      fileName: 'meta.txt',
      source: new BufferSource(content),
      contentType: 'text/plain',
    })

    const obj = bucket.file('meta.txt')
    const info = await obj.getFileInfo(uploaded.fileId)

    expect(info.fileName).toBe('meta.txt')
    expect(info.fileId).toBe(uploaded.fileId)
    expect(info.contentLength).toBe(content.byteLength)
    expect(info.contentType).toBe('text/plain')
    expect(info.action).toBe('upload')
  })

  it('hide() creates a hide marker and surfaces it as the latest row in name listing', async () => {
    // Real B2 surfaces the hide marker as the row for that name in
    // `listFileNames` (not absence). See `client.test.ts` for the full
    // contract; this test focuses on the per-file `B2Object.hide()` path.
    const bucket = await client.createBucket({
      bucketName: 'obj-hide-cov',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'will-hide.txt',
      source: new BufferSource(new TextEncoder().encode('soon hidden')),
    })

    const obj = bucket.file('will-hide.txt')
    const marker = await obj.hide()
    expect(marker.action).toBe('hide')
    expect(marker.fileName).toBe('will-hide.txt')

    const listing = await bucket.listFileNames()
    const row = listing.files.find((f) => f.fileName === 'will-hide.txt')
    expect(row?.action).toBe('hide')
    expect(row?.contentLength).toBe(0)
  })

  it('deleteVersion() removes a specific file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-delver-cov',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'ephemeral.txt',
      source: new BufferSource(new TextEncoder().encode('temporary')),
    })

    const obj = bucket.file('ephemeral.txt')
    await obj.deleteVersion(uploaded.fileId)

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// B2Client - coverage for high-level createKey, deleteKey, listKeys,
//            and listBuckets with filter options
// ---------------------------------------------------------------------------

describe('B2Client high-level key management', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('createKey() returns a full application key', async () => {
    const key = await client.createKey({
      capabilities: [
        Capability.ReadFiles,
        Capability.WriteFiles,
        Capability.ReadBucketLogging,
        Capability.WriteBucketLogging,
      ],
      keyName: 'hl-test-key',
    })

    expect(key.keyName).toBe('hl-test-key')
    expect(key.applicationKeyId).toBeTruthy()
    expect(key.applicationKey).toBeTruthy()
    expect(key.capabilities).toContain(Capability.ReadFiles)
    expect(key.capabilities).toContain(Capability.WriteFiles)
    expect(key.capabilities).toContain(Capability.ReadBucketLogging)
    expect(key.capabilities).toContain(Capability.WriteBucketLogging)
    expect(key.bucketIds).toBeNull()
  })

  it('createKey() with single-bucket scope and name prefix', async () => {
    const bucket = await client.createBucket({
      bucketName: 'key-scope-hl',
      bucketType: BucketType.AllPrivate,
    })

    const key = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'scoped-hl',
      bucketIds: [bucket.id],
      namePrefix: 'images/',
    })

    expect(key.bucketIds).toEqual([bucket.id])
    expect(key.namePrefix).toBe('images/')
  })

  it('createKey() accepts the deprecated bucketId alias', async () => {
    const bucket = await client.createBucket({
      bucketName: 'key-alias-hl',
      bucketType: BucketType.AllPrivate,
    })

    const key = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'alias-hl',
      bucketId: bucket.id,
    })

    expect(key.bucketIds).toEqual([bucket.id])
    expect(key.bucketId).toBe(bucket.id)
  })

  it('createKey() rejects conflicting bucketId and bucketIds inputs', async () => {
    const bucket = await client.createBucket({
      bucketName: 'key-conflict-hl',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      client.createKey({
        capabilities: [Capability.ReadFiles],
        keyName: 'conflict-hl-null',
        bucketIds: null,
        bucketId: bucket.id,
      }),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    const untrusted = { bucketIds: ['user-bucket'] as never }
    await expect(
      client.createKey({
        capabilities: [Capability.ReadFiles],
        keyName: 'conflict-hl-merge',
        ...untrusted,
        bucketId: bucket.id,
      }),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')
  })

  it('createKey() supports multi-bucket scope', async () => {
    const first = await client.createBucket({
      bucketName: 'key-multi-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'key-multi-b',
      bucketType: BucketType.AllPrivate,
    })

    const key = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'multi-hl',
      bucketIds: [first.id, second.id],
    })

    expect(key.bucketIds).toEqual([first.id, second.id])
    expect(key.bucketId).toBeNull()

    const listing = await client.listKeys()
    const found = listing.keys.find((k) => k.keyName === 'multi-hl')
    expect(found?.bucketIds).toEqual([first.id, second.id])
    expect(found?.bucketId).toBeNull()
  })

  it('listKeys() returns keys created via the high-level API', async () => {
    await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'list-me',
    })

    const result = await client.listKeys()

    expect(result.keys.length).toBeGreaterThanOrEqual(1)
    const found = result.keys.find((k) => k.keyName === 'list-me')
    expect(found).toBeTruthy()
    expect(found?.capabilities).toContain(Capability.ListBuckets)
  })

  it('listKeys() respects pageSize for pagination', async () => {
    await client.createKey({ capabilities: [Capability.ReadFiles], keyName: 'pk-a' })
    await client.createKey({ capabilities: [Capability.ReadFiles], keyName: 'pk-b' })
    await client.createKey({ capabilities: [Capability.ReadFiles], keyName: 'pk-c' })

    const page = await client.listKeys({ pageSize: 2 })
    expect(page.keys).toHaveLength(2)
    expect(page.nextApplicationKeyId).toBeTruthy()
  })

  it('deleteKey() removes the key from subsequent listings', async () => {
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'delete-hl',
    })

    const deleted = await client.deleteKey(key.applicationKeyId)
    expect(deleted.keyName).toBe('delete-hl')

    const listing = await client.listKeys()
    const found = listing.keys.find((k) => k.keyName === 'delete-hl')
    expect(found).toBeUndefined()
  })
})

describe('B2Client listBuckets with filter options', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('listBuckets() with bucketName filter passes the option through', async () => {
    await client.createBucket({ bucketName: 'alpha-bucket', bucketType: BucketType.AllPrivate })
    await client.createBucket({ bucketName: 'beta-bucket', bucketType: BucketType.AllPublic })

    const buckets = await client.listBuckets({ bucketName: 'alpha-bucket' })
    expect(buckets.map((bucket) => bucket.name)).toEqual(['alpha-bucket'])
  })

  it('listBuckets() with bucketTypes filter passes the option through', async () => {
    await client.createBucket({ bucketName: 'priv-bucket', bucketType: BucketType.AllPrivate })
    await client.createBucket({ bucketName: 'pub-bucket', bucketType: BucketType.AllPublic })

    const buckets = await client.listBuckets({ bucketTypes: [BucketType.AllPrivate] })
    expect(buckets.map((bucket) => bucket.name)).toEqual(['priv-bucket'])
  })

  it('listBuckets() with bucketId filter passes the option through', async () => {
    const bucket = await client.createBucket({
      bucketName: 'by-id-filter',
      bucketType: BucketType.AllPrivate,
    })

    const buckets = await client.listBuckets({ bucketId: bucket.id })
    expect(buckets.map((found) => found.id)).toEqual([bucket.id])
  })
})

// ---------------------------------------------------------------------------
// Bucket - coverage for listFileVersions, hideFile, deleteFileVersion,
//          paginateFileNames async iterator, getDownloadAuthorization, copyFile
// ---------------------------------------------------------------------------

describe('Bucket coverage', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('listFileVersions() returns uploads and hide markers together', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-cov',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'versioned.txt',
      source: new BufferSource(new TextEncoder().encode('v1')),
    })
    await bucket.upload({
      fileName: 'versioned.txt',
      source: new BufferSource(new TextEncoder().encode('v2')),
    })
    await bucket.hideFile('versioned.txt')

    const resp = await bucket.listFileVersions()
    const versions = resp.files.filter((f) => f.fileName === 'versioned.txt')
    expect(versions).toHaveLength(3)

    const actions = versions.map((v) => v.action)
    expect(actions.filter((a) => a === 'upload')).toHaveLength(2)
    expect(actions.filter((a) => a === 'hide')).toHaveLength(1)
  })

  it('listFileVersions() paginates with startFileName', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-page-cov',
      bucketType: BucketType.AllPrivate,
    })
    for (let i = 0; i < 4; i++) {
      await bucket.upload({
        fileName: `f-${String(i).padStart(2, '0')}.txt`,
        source: new BufferSource(new TextEncoder().encode(`c${i}`)),
      })
    }

    const page1 = await bucket.listFileVersions({ pageSize: 2 })
    expect(page1.files).toHaveLength(2)
    expect(page1.nextFileName).toBeTruthy()

    const page2 = await bucket.listFileVersions({
      pageSize: 2,
      ...(page1.nextFileName !== null ? { startFileName: page1.nextFileName } : {}),
    })
    expect(page2.files).toHaveLength(2)
    expect(page2.files[0]?.fileName).toBe('f-02.txt')
  })

  it('hideFile() surfaces a hide marker in listFileNames and the full chain in listFileVersions', async () => {
    // Real B2: `b2_list_file_names` returns one row per file name with the
    // most recent version. For a hidden file, that row IS the hide marker
    // (`action: 'hide'`, `contentLength: 0`). `b2_list_file_versions`
    // returns BOTH the marker and the underlying upload(s).
    const bucket = await client.createBucket({
      bucketName: 'hide-vis-cov',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'peek.txt',
      source: new BufferSource(new TextEncoder().encode('peekaboo')),
    })
    const hidden = await bucket.hideFile('peek.txt')
    expect(hidden.action).toBe('hide')

    // Hide marker is the row in listFileNames.
    const names = await bucket.listFileNames()
    const row = names.files.find((f) => f.fileName === 'peek.txt')
    expect(row?.action).toBe('hide')
    expect(row?.contentLength).toBe(0)

    // Full history (upload + hide) lives in listFileVersions.
    const versions = await bucket.listFileVersions()
    const peekVersions = versions.files.filter((f) => f.fileName === 'peek.txt')
    expect(peekVersions.length).toBeGreaterThanOrEqual(2)
  })

  it('deleteFileVersion() removes only the targeted version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'del-ver-cov',
      bucketType: BucketType.AllPrivate,
    })

    const v1 = await bucket.upload({
      fileName: 'multi.txt',
      source: new BufferSource(new TextEncoder().encode('first')),
    })
    await bucket.upload({
      fileName: 'multi.txt',
      source: new BufferSource(new TextEncoder().encode('second')),
    })

    // Delete only the first version
    await bucket.deleteFileVersion('multi.txt', v1.fileId)

    const versions = await bucket.listFileVersions()
    const remaining = versions.files.filter((f) => f.fileName === 'multi.txt')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.fileId).not.toBe(v1.fileId)
  })

  it('paginateFileNames() async iterator yields all files across pages', async () => {
    const bucket = await client.createBucket({
      bucketName: 'allfiles-cov',
      bucketType: BucketType.AllPrivate,
    })

    const names: string[] = []
    for (let i = 0; i < 7; i++) {
      const name = `gen-${String(i).padStart(2, '0')}.dat`
      names.push(name)
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(`payload-${i}`)),
      })
    }

    const collected: string[] = []
    for await (const file of bucket.paginateFileNames({ pageSize: 3 })) {
      collected.push(file.fileName)
    }

    expect(collected).toEqual(names)
  })

  it('paginateFileNames() with prefix only yields matching files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'allfiles-pfx',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'logs/app.log',
      source: new BufferSource(new TextEncoder().encode('log data')),
    })
    await bucket.upload({
      fileName: 'logs/error.log',
      source: new BufferSource(new TextEncoder().encode('error data')),
    })
    await bucket.upload({
      fileName: 'data/report.csv',
      source: new BufferSource(new TextEncoder().encode('csv data')),
    })

    const collected: string[] = []
    for await (const file of bucket.paginateFileNames({ prefix: 'logs/' })) {
      collected.push(file.fileName)
    }

    expect(collected).toHaveLength(2)
    expect(collected.every((n) => n.startsWith('logs/'))).toBe(true)
  })

  it('getDownloadAuthorization() returns a scoped token', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-auth-cov',
      bucketType: BucketType.AllPrivate,
    })

    const auth = await bucket.getDownloadAuthorization('docs/', 7200)
    expect(auth.bucketId).toBe(bucket.id)
    expect(auth.fileNamePrefix).toBe('docs/')
    expect(auth.authorizationToken).toBeTruthy()
  })

  it('copyFile() copies content within the same bucket', async () => {
    const bucket = await client.createBucket({
      bucketName: 'copy-cov',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('original bytes')
    const original = await bucket.upload({
      fileName: 'source.dat',
      source: new BufferSource(content),
    })

    const copied = await bucket.copyFile({
      sourceFileId: original.fileId,
      fileName: 'clone.dat',
    })

    expect(copied.fileName).toBe('clone.dat')
    expect(copied.contentLength).toBe(content.byteLength)
    expect(copied.action).toBe('copy')

    // Verify the copied file is downloadable with correct content
    const result = await bucket.download('clone.dat')
    const data = await readStream(result.body)
    expect(new TextDecoder().decode(data)).toBe('original bytes')
  })

  it('copyFile() copies to a different bucket', async () => {
    const src = await client.createBucket({
      bucketName: 'cp-src-cov',
      bucketType: BucketType.AllPrivate,
    })
    const dst = await client.createBucket({
      bucketName: 'cp-dst-cov',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('cross bucket data')
    const original = await src.upload({
      fileName: 'origin.bin',
      source: new BufferSource(content),
    })

    const copied = await src.copyFile({
      sourceFileId: original.fileId,
      fileName: 'replica.bin',
      destinationBucketId: dst.id,
    })

    expect(copied.fileName).toBe('replica.bin')

    const result = await dst.download('replica.bin')
    const data = await readStream(result.body)
    expect(new TextDecoder().decode(data)).toBe('cross bucket data')
  })

  // updateFileRetention and updateFileLegalHold are NOT implemented in the
  // simulator (no handler for b2_update_file_retention or
  // b2_update_file_legal_hold). Tests for those methods would require either
  // extending the simulator or using a real B2 account.
})

// ---------------------------------------------------------------------------
// B2Object - coverage for download (by name) and createReadStream
// ---------------------------------------------------------------------------

describe('B2Object download and stream coverage', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('download() returns the correct file content by name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-dl-name',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('download-by-name-body')
    await bucket.upload({
      fileName: 'named.bin',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const obj = bucket.file('named.bin')
    const result = await obj.download()
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('download-by-name-body')
    expect(result.headers.contentLength).toBe(content.byteLength)
  })

  it('download() with range returns partial content', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-dl-range',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('hello world range test')
    await bucket.upload({
      fileName: 'ranged.txt',
      source: new BufferSource(content),
      contentType: 'text/plain',
    })

    const obj = bucket.file('ranged.txt')
    const result = await obj.download({ range: 'bytes=0-3' })
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('hell')
    expect(result.headers.contentLength).toBe(4)
  })

  it('createReadStream() returns the full file via parallel download', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-stream',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('parallel download stream content here')
    const uploaded = await bucket.upload({
      fileName: 'streamed.dat',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const obj = bucket.file('streamed.dat')
    const stream = obj.createReadStream(uploaded.fileId, content.byteLength, {
      rangeSize: 10,
      concurrency: 1,
    })
    const data = await readStream(stream)

    expect(new TextDecoder().decode(data)).toBe('parallel download stream content here')
  })

  it('upload() routes to large file path when source exceeds recommended part size', async () => {
    // Use a dedicated client backed by a simulator with a tiny
    // `recommendedPartSize` so the small-vs-large dispatch in
    // `B2Object.upload` naturally picks the multipart path. Previous
    // version of this test mocked `client.accountInfo.getRecommendedPartSize`
    // via `vi.spyOn` — that mock-coupled to an internal API surface.
    // The simulator's `B2SimulatorOptions.recommendedPartSize` is the
    // documented test seam for exactly this case.
    const { client: largeRouteClient } = makeClient({
      minimumPartSize: 10,
      recommendedPartSize: 10,
    })
    await largeRouteClient.authorize()
    const bucket = await largeRouteClient.createBucket({
      bucketName: 'obj-large-route',
      bucketType: BucketType.AllPrivate,
    })

    const content = new TextEncoder().encode('this exceeds the simulator part size')
    const obj = bucket.file('large-route.bin')
    const result = await obj.upload({ source: new BufferSource(content) })

    expect(result.fileName).toBe('large-route.bin')
    expect(result.contentLength).toBe(content.byteLength)
  })
})
