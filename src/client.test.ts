import { beforeEach, describe, expect, it } from 'vitest'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BufferSource } from './streams/source.ts'
import { daysFromNow, makeClient, readStream } from './test-utils/index.ts'
import { Capability } from './types/auth.ts'
import { BucketType } from './types/bucket.ts'
import type { LargeFileId } from './types/ids.ts'
import { EventType } from './types/notifications.ts'

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
      bucketType: BucketType.AllPrivate,
    })

    expect(bucket.name).toBe('test-bucket')
    expect(bucket.id).toBeTruthy()

    const buckets = await client.listBuckets()
    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.name).toBe('test-bucket')
  })

  it('propagates fileLockEnabled into the returned bucket info', async () => {
    // Regression: simulator previously hardcoded
    // `isFileLockEnabled: false` regardless of the create request,
    // forcing test code to mutate `bucket.info` post-hoc to simulate a
    // locked bucket. The flag must round-trip end-to-end so the sync
    // engine's `removeOrphan` policy branch picks `hide` for locked
    // buckets without a manual mutation step.
    const locked = await client.createBucket({
      bucketName: 'with-lock',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    expect(locked.info.fileLockConfiguration.value?.isFileLockEnabled).toBe(true)

    const unlocked = await client.createBucket({
      bucketName: 'without-lock',
      bucketType: BucketType.AllPrivate,
    })
    expect(unlocked.info.fileLockConfiguration.value?.isFileLockEnabled).toBe(false)
  })

  it('prevents duplicate bucket names', async () => {
    await client.createBucket({ bucketName: 'my-bucket', bucketType: BucketType.AllPrivate })

    await expect(
      client.createBucket({ bucketName: 'my-bucket', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow('Bucket name already in use')
  })

  it('deletes a bucket', async () => {
    const bucket = await client.createBucket({
      bucketName: 'to-delete',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.delete()

    const buckets = await client.listBuckets()
    expect(buckets).toHaveLength(0)
  })

  it('gets a bucket by name', async () => {
    await client.createBucket({ bucketName: 'find-me', bucketType: BucketType.AllPublic })

    const found = await client.getBucket('find-me')
    expect(found).not.toBeNull()
    expect(found?.name).toBe('find-me')
  })

  it('uploads and lists files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'upload-test',
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
    })

    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']
    for (const name of names) {
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(name)),
      })
    }

    const collected: string[] = []
    for await (const file of bucket.paginateFileNames()) {
      collected.push(file.fileName)
    }

    expect(collected).toEqual(names)
  })

  it('uses B2Object handle for upload', async () => {
    const bucket = await client.createBucket({
      bucketName: 'object-test',
      bucketType: BucketType.AllPrivate,
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

// --- SSRF guard integration ---

describe('B2Client SSRF guard', () => {
  it('exposes urlGuard=null when a custom transport is supplied (user owns hardening)', () => {
    const sim = new B2Simulator()
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
    })
    expect(client.urlGuard).toBeNull()
  })

  it('locks the urlGuard to the realm domains after authorize() with the default transport', async () => {
    const { vi } = await import('vitest')
    const { B2SsrfError } = await import('./errors/index.ts')

    // Capture the original fetch so we can restore it after the test.
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString()
      if (u.startsWith('https://api.backblazeb2.com/b2api/v3/b2_authorize_account')) {
        // Minimal authorize-account response shape consumed by the SDK.
        return new Response(
          JSON.stringify({
            accountId: 'a',
            authorizationToken: 't',
            apiInfo: {
              storageApi: {
                apiUrl: 'https://api.us-west-004.backblazeb2.com',
                downloadUrl: 'https://f004.backblazeb2.com',
                s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
                absoluteMinimumPartSize: 5_000_000,
                recommendedPartSize: 100_000_000,
                capabilities: [Capability.ReadFiles, Capability.WriteFiles],
                bucketId: null,
                bucketName: null,
                namePrefix: null,
              },
            },
            applicationKeyExpirationTimestamp: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    try {
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
      })

      // Before authorize, guard is permissive.
      expect(client.urlGuard?.getAllowedSuffixes()).toEqual([])

      await client.authorize()

      // After authorize, guard locks to realm + backblaze.com.
      const suffixes = client.urlGuard?.getAllowedSuffixes() ?? []
      expect(suffixes).toContain('backblazeb2.com')
      expect(suffixes).toContain('backblaze.com')

      // Any direct transport call to a hostile URL is now rejected without
      // ever issuing a network request. Use the inner FetchTransport via the
      // raw client's transport chain by sending a request whose URL points
      // at the metadata service — bypassing the high-level facade so we
      // exercise just the guard.
      const innerTransport = client.urlGuard
      expect(() => innerTransport?.check('http://169.254.169.254/latest/meta-data/')).toThrow(
        B2SsrfError,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('merges user-supplied allowedHostSuffixes with the auto-derived set', async () => {
    const { vi } = await import('vitest')
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accountId: 'a',
            authorizationToken: 't',
            apiInfo: {
              storageApi: {
                apiUrl: 'https://api.backblazeb2.com',
                downloadUrl: 'https://f001.backblazeb2.com',
                s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
                absoluteMinimumPartSize: 5_000_000,
                recommendedPartSize: 100_000_000,
                capabilities: [Capability.ReadFiles],
                bucketId: null,
                bucketName: null,
                namePrefix: null,
              },
            },
            applicationKeyExpirationTimestamp: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    try {
      const client = new B2Client({
        applicationKeyId: 'k',
        applicationKey: 's',
        // E.g. user routes traffic through a self-hosted MITM proxy for
        // debugging and needs to allow its host.
        allowedHostSuffixes: ['internal-proxy.example'],
      })
      await client.authorize()

      const suffixes = client.urlGuard?.getAllowedSuffixes() ?? []
      expect(suffixes).toContain('backblazeb2.com')
      expect(suffixes).toContain('backblaze.com')
      expect(suffixes).toContain('internal-proxy.example')
    } finally {
      globalThis.fetch = originalFetch
    }
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
    const bucket = await client.createBucket({
      bucketName: 'dl-test',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('download me')
    await bucket.upload({ fileName: 'hello.txt', source: new BufferSource(content) })

    const result = await bucket.download('hello.txt')
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('download me')
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileName).toBe('hello.txt')
  })

  it('downloads a file by id via B2Object', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-by-id',
      bucketType: BucketType.AllPrivate,
    })
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
    const bucket = await client.createBucket({
      bucketName: 'dl-range',
      bucketType: BucketType.AllPrivate,
    })
    const content = new TextEncoder().encode('0123456789abcdef')
    await bucket.upload({ fileName: 'range.bin', source: new BufferSource(content) })

    const result = await bucket.download('range.bin', { range: 'bytes=4-7' })
    const data = await readStream(result.body)

    expect(new TextDecoder().decode(data)).toBe('4567')
  })

  it('throws on download of missing file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-miss',
      bucketType: BucketType.AllPrivate,
    })

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
    const bucket = await client.createBucket({
      bucketName: 'info-test',
      bucketType: BucketType.AllPrivate,
    })
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

  it('hides a file and surfaces it in listing as a hide marker', async () => {
    // Real B2 behaviour: `b2_list_file_names` returns one entry per file
    // name, taking the most recent version. For a hidden file, the most
    // recent version IS the hide marker, so it appears in the listing
    // with `action: 'hide'` and `contentLength: 0`. Consumers must skip
    // hide-action rows when iterating over "live" files.
    const bucket = await client.createBucket({
      bucketName: 'hide-test',
      bucketType: BucketType.AllPrivate,
    })
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
    const byName = new Map(listing.files.map((f) => [f.fileName, f]))
    expect(byName.get('visible.txt')?.action).toBe('upload')
    const hiddenEntry = byName.get('hidden.txt')
    expect(hiddenEntry).toBeDefined()
    expect(hiddenEntry?.action).toBe('hide')
    expect(hiddenEntry?.contentLength).toBe(0)
  })

  it('hides a file via B2Object.hide()', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-hide',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'to-hide.txt',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    const obj = bucket.file('to-hide.txt')
    const result = await obj.hide()
    expect(result.action).toBe('hide')

    // Hide markers are surfaced in listings (see the previous test for
    // rationale). The row exists with `action: 'hide'`.
    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(1)
    expect(listing.files[0]?.action).toBe('hide')
    expect(listing.files[0]?.fileName).toBe('to-hide.txt')
  })

  it('paginateFileNames skips hide markers but listFileNames includes them', async () => {
    // Real B2: `b2_list_file_names` returns one row per file name; for a
    // hidden file that row is the hide marker. The SDK's
    // `Bucket.paginateFileNames` iterator advertises "latest VISIBLE
    // version" semantics and therefore filters hide-action rows. This
    // test pins both contracts simultaneously so a future simulator
    // tweak can't silently drift the SDK's iterator behaviour.
    const bucket = await client.createBucket({
      bucketName: 'hide-vs-paginate',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'live-1.txt',
      source: new BufferSource(new TextEncoder().encode('a')),
    })
    await bucket.upload({
      fileName: 'will-hide.txt',
      source: new BufferSource(new TextEncoder().encode('b')),
    })
    await bucket.upload({
      fileName: 'live-2.txt',
      source: new BufferSource(new TextEncoder().encode('c')),
    })
    await bucket.hideFile('will-hide.txt')

    // Raw API surfaces all three rows; the hidden one carries action: 'hide'.
    const raw = await bucket.listFileNames()
    expect(raw.files).toHaveLength(3)
    const hideRow = raw.files.find((f) => f.fileName === 'will-hide.txt')
    expect(hideRow?.action).toBe('hide')
    expect(hideRow?.contentLength).toBe(0)

    // Async iterator drops the hide-action row.
    const viaIterator: string[] = []
    for await (const f of bucket.paginateFileNames()) viaIterator.push(f.fileName)
    expect(viaIterator.sort()).toEqual(['live-1.txt', 'live-2.txt'])
  })

  it('deletes a file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'del-ver',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'delete-me.txt',
      source: new BufferSource(new TextEncoder().encode('bye')),
    })

    await bucket.deleteFileVersion('delete-me.txt', uploaded.fileId)

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(0)
  })

  it('deletes via B2Object.deleteVersion()', async () => {
    const bucket = await client.createBucket({
      bucketName: 'obj-del',
      bucketType: BucketType.AllPrivate,
    })
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
    const bucket = await client.createBucket({
      bucketName: 'copy-test',
      bucketType: BucketType.AllPrivate,
    })
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
    const src = await client.createBucket({
      bucketName: 'copy-src',
      bucketType: BucketType.AllPrivate,
    })
    const dest = await client.createBucket({
      bucketName: 'copy-dest',
      bucketType: BucketType.AllPrivate,
    })
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
      bucketType: BucketType.AllPrivate,
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

  it('respects pageSize in versions listing', async () => {
    const bucket = await client.createBucket({
      bucketName: 'ver-page',
      bucketType: BucketType.AllPrivate,
    })
    for (let i = 0; i < 5; i++) {
      await bucket.upload({
        fileName: `file-${String(i).padStart(2, '0')}.txt`,
        source: new BufferSource(new TextEncoder().encode(`content-${i}`)),
      })
    }

    const page = await bucket.listFileVersions({ pageSize: 2 })
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
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.info.bucketType).toBe('allPrivate')

    const updated = await bucket.update({ bucketType: BucketType.AllPublic })
    expect(updated.bucketType).toBe(BucketType.AllPublic)
    expect(updated.revision).toBe(2)
  })

  it('updates bucket info metadata', async () => {
    const bucket = await client.createBucket({
      bucketName: 'meta-update',
      bucketType: BucketType.AllPrivate,
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
    // Lower minimumPartSize so the test's tiny 1024-byte parts pass
    // the simulator's spec-compliant part-size enforcement
    // (`b2_finish_large_file` rejects non-last parts below
    // `absoluteMinimumPartSize`). Production simulator default is 5MB.
    ;({ client } = makeClient({ minimumPartSize: 1024 }))
    await client.authorize()
  })

  it('starts, uploads parts, and finishes a large file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'large-test',
      bucketType: BucketType.AllPrivate,
    })

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
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
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

// --- Bucket.cancelLargeFile + Bucket.listUnfinishedLargeFiles tests ---

describe('Bucket large-file high-level helpers', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('cancelLargeFile cleans up an in-progress upload via the Bucket handle', async () => {
    const bucket = await client.createBucket({
      bucketName: 'cancel-via-bucket',
      bucketType: BucketType.AllPrivate,
    })

    const startResp = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'orphan.bin', contentType: 'application/octet-stream' },
    )

    const cancelResp = await bucket.cancelLargeFile(startResp.fileId as unknown as LargeFileId)
    expect(cancelResp.fileName).toBe('orphan.bin')

    const remaining = await bucket.listUnfinishedLargeFiles()
    expect(remaining.files.find((f) => f.fileName === 'orphan.bin')).toBeUndefined()
  })

  it('listUnfinishedLargeFiles exposes unfinished uploads scoped to this bucket', async () => {
    const bucket = await client.createBucket({
      bucketName: 'list-unfinished',
      bucketType: BucketType.AllPrivate,
    })

    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'a.bin', contentType: 'application/octet-stream' },
    )
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'b.bin', contentType: 'application/octet-stream' },
    )

    const listing = await bucket.listUnfinishedLargeFiles()
    expect(listing.files).toHaveLength(2)
    expect(listing.files.map((f) => f.fileName).sort()).toEqual(['a.bin', 'b.bin'])
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
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
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

  it('paginates file listing with pageSize', async () => {
    const bucket = await client.createBucket({
      bucketName: 'page-test',
      bucketType: BucketType.AllPrivate,
    })
    for (let i = 0; i < 5; i++) {
      await bucket.upload({
        fileName: `file-${String(i).padStart(2, '0')}.txt`,
        source: new BufferSource(new TextEncoder().encode(`c${i}`)),
      })
    }

    const page1 = await bucket.listFileNames({ pageSize: 2 })
    expect(page1.files).toHaveLength(2)
    expect(page1.nextFileName).toBe('file-02.txt')

    const page2 = await bucket.listFileNames({
      pageSize: 2,
      ...(page1.nextFileName !== null ? { startFileName: page1.nextFileName } : {}),
    })
    expect(page2.files).toHaveLength(2)
    expect(page2.files[0]?.fileName).toBe('file-02.txt')
  })

  it('async generator iterates all pages', async () => {
    const bucket = await client.createBucket({
      bucketName: 'allfiles-test',
      bucketType: BucketType.AllPrivate,
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
    for await (const file of bucket.paginateFileNames({ pageSize: 3 })) {
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
      bucketType: BucketType.AllPrivate,
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
      bucketType: BucketType.AllPrivate,
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
    const { accountId } = await import('./types/ids.ts')

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: [Capability.ReadFiles, Capability.WriteFiles],
        keyName: 'test-key',
      },
    )

    expect(key.keyName).toBe('test-key')
    expect(key.applicationKeyId).toBeTruthy()
    expect(key.applicationKey).toBeTruthy()
    expect(key.capabilities).toContain(Capability.ReadFiles)
    expect(key.capabilities).toContain(Capability.WriteFiles)

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
    const { accountId } = await import('./types/ids.ts')

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: [Capability.ListBuckets],
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
    const { accountId } = await import('./types/ids.ts')
    const bucket = await client.createBucket({
      bucketName: 'key-scope',
      bucketType: BucketType.AllPrivate,
    })

    const key = await client.raw.createKey(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        accountId: accountId(client.accountInfo.getAccountId()),
        capabilities: [Capability.ReadFiles],
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
      bucketType: BucketType.AllPrivate,
    })

    const rules = await bucket.getNotificationRules()
    expect(rules.eventNotificationRules).toEqual([])
    expect(rules.bucketId).toBe(bucket.id)
  })

  it('sets and gets notification rules', async () => {
    const bucket = await client.createBucket({
      bucketName: 'notif-set',
      bucketType: BucketType.AllPrivate,
    })

    const rule = {
      eventTypes: [EventType.ObjectCreatedAll] as const,
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
      bucketType: BucketType.AllPrivate,
    })

    await bucket.setNotificationRules([
      {
        eventTypes: [EventType.ObjectCreatedAll],
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
        eventTypes: [EventType.ObjectDeletedAll],
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

// --- File retention and legal hold tests ---

describe('file retention and legal hold', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('updates file retention on a file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'retention-test',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('retain me')
    const uploaded = await bucket.upload({
      fileName: 'locked.txt',
      source: new BufferSource(data),
    })

    const retention = { mode: 'compliance' as const, retainUntilTimestamp: daysFromNow(1) }
    const result = await bucket.updateFileRetention('locked.txt', uploaded.fileId, retention)

    expect(result.fileName).toBe('locked.txt')
    expect(result.fileId).toBe(uploaded.fileId)
    expect(result.fileRetention.mode).toBe('compliance')
    expect(result.fileRetention.retainUntilTimestamp).toBe(retention.retainUntilTimestamp)
  })

  it('updates file legal hold on a file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'legal-hold-test',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('hold me')
    const uploaded = await bucket.upload({
      fileName: 'held.txt',
      source: new BufferSource(data),
    })

    const result = await bucket.updateFileLegalHold('held.txt', uploaded.fileId, 'on')

    expect(result.fileName).toBe('held.txt')
    expect(result.fileId).toBe(uploaded.fileId)
    expect(result.legalHold).toBe('on')
  })

  it('removes legal hold from a file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'legal-hold-off',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('release me')
    const uploaded = await bucket.upload({
      fileName: 'released.txt',
      source: new BufferSource(data),
    })

    await bucket.updateFileLegalHold('released.txt', uploaded.fileId, 'on')
    const result = await bucket.updateFileLegalHold('released.txt', uploaded.fileId, 'off')

    expect(result.legalHold).toBe('off')
  })

  it('retention is reflected in file info after update', async () => {
    const bucket = await client.createBucket({
      bucketName: 'retention-info',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('check info')
    const uploaded = await bucket.upload({
      fileName: 'check.txt',
      source: new BufferSource(data),
    })

    const retention = { mode: 'governance' as const, retainUntilTimestamp: daysFromNow(1 / 24) }
    await bucket.updateFileRetention('check.txt', uploaded.fileId, retention)

    const obj = bucket.file('check.txt')
    const info = await obj.getFileInfo(uploaded.fileId)
    expect(info.fileRetention.value).toEqual(retention)
  })

  it('legal hold is reflected in file info after update', async () => {
    const bucket = await client.createBucket({
      bucketName: 'legalhold-info',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('check hold')
    const uploaded = await bucket.upload({
      fileName: 'holdcheck.txt',
      source: new BufferSource(data),
    })

    await bucket.updateFileLegalHold('holdcheck.txt', uploaded.fileId, 'on')

    const obj = bucket.file('holdcheck.txt')
    const info = await obj.getFileInfo(uploaded.fileId)
    expect(info.legalHold.value).toBe('on')
  })

  it('updateFileRetention forwards bypassGovernance flag', async () => {
    const bucket = await client.createBucket({
      bucketName: 'bypass-test',
      bucketType: BucketType.AllPrivate,
    })
    const data = new TextEncoder().encode('bypass me')
    const uploaded = await bucket.upload({
      fileName: 'bypass.txt',
      source: new BufferSource(data),
    })

    const retention = { mode: 'governance' as const, retainUntilTimestamp: daysFromNow(1 / 24) }
    const result = await bucket.updateFileRetention('bypass.txt', uploaded.fileId, retention, {
      bypassGovernance: true,
    })
    expect(result.fileRetention.mode).toBe('governance')
  })
})

describe('B2Client.hasCapabilities', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('returns ok: true when every needed capability is present', () => {
    const result = client.hasCapabilities([
      Capability.ListBuckets,
      Capability.ReadFiles,
      Capability.WriteFiles,
    ])
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('returns ok: false with the missing list when capabilities are absent', () => {
    const result = client.hasCapabilities([Capability.ListBuckets, Capability.BypassGovernance])
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([Capability.BypassGovernance])
  })

  it('handles an empty needed array', () => {
    expect(client.hasCapabilities([])).toEqual({ ok: true, missing: [] })
  })

  it('throws if called before authorize', () => {
    const unauth = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: new B2Simulator().transport(),
    })
    expect(() => unauth.hasCapabilities([Capability.ListBuckets])).toThrow(/Not authorized/)
  })
})

describe('Bucket.getFileInfoByName and Bucket.unhide', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('getFileInfoByName returns the latest visible file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'gfibn-test',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({
      fileName: 'visible.txt',
      source: new BufferSource(new TextEncoder().encode('hello')),
    })

    const info = await bucket.getFileInfoByName('visible.txt')
    expect(info?.fileId).toBe(uploaded.fileId)
    expect(info?.fileName).toBe('visible.txt')
  })

  it('getFileInfoByName returns null for unknown file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'gfibn-missing',
      bucketType: BucketType.AllPrivate,
    })
    const info = await bucket.getFileInfoByName('nope.txt')
    expect(info).toBeNull()
  })

  it('getFileInfoByName returns null for a hidden file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'gfibn-hidden',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'shy.txt',
      source: new BufferSource(new TextEncoder().encode('shy')),
    })
    await bucket.hideFile('shy.txt')

    const info = await bucket.getFileInfoByName('shy.txt')
    expect(info).toBeNull()
  })

  it('unhideFile removes the hide marker and restores visibility', async () => {
    const bucket = await client.createBucket({
      bucketName: 'unhide-test',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'restore.txt',
      source: new BufferSource(new TextEncoder().encode('boo')),
    })
    await bucket.hideFile('restore.txt')
    expect(await bucket.getFileInfoByName('restore.txt')).toBeNull()

    const marker = await bucket.unhideFile('restore.txt')
    expect(marker?.action).toBe('hide')

    const restored = await bucket.getFileInfoByName('restore.txt')
    expect(restored?.fileName).toBe('restore.txt')
  })

  it('unhideFile returns null when there is no hide marker on top', async () => {
    const bucket = await client.createBucket({
      bucketName: 'unhide-noop',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'plain.txt',
      source: new BufferSource(new TextEncoder().encode('plain')),
    })

    const result = await bucket.unhideFile('plain.txt')
    expect(result).toBeNull()
  })

  it('unhideFile returns null when the file does not exist', async () => {
    const bucket = await client.createBucket({
      bucketName: 'unhide-missing',
      bucketType: BucketType.AllPrivate,
    })
    const result = await bucket.unhideFile('ghost.txt')
    expect(result).toBeNull()
  })
})

describe('B2Client constructor options', () => {
  it('creates default FetchTransport when no transport is provided', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
    })
    expect(client.raw).toBeTruthy()
    expect(client.accountInfo).toBeTruthy()
  })

  it('creates FetchTransport with custom userAgent', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      userAgent: 'my-app/2.0',
    })
    expect(client.raw).toBeTruthy()
  })

  it('passes retry options through', () => {
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      retry: { maxRetries: 10 },
    })
    expect(client.raw).toBeTruthy()
  })
})

describe('error classification', () => {
  it('classifies expired_auth_token as retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({
      status: 401,
      code: 'expired_auth_token',
      message: 'Token expired',
    })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ExpiredAuthTokenError')
  })

  it('classifies cap_exceeded as not retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({ status: 403, code: 'cap_exceeded', message: 'Cap exceeded' })
    expect(error.retryable).toBe(false)
    expect(error.name).toBe('CapExceededError')
  })

  it('classifies 503 as retryable', async () => {
    const { classifyError } = await import('./errors/index.ts')
    const error = classifyError({ status: 503, code: 'service_unavailable', message: 'Try again' })
    expect(error.retryable).toBe(true)
    expect(error.name).toBe('ServiceUnavailableError')
  })
})

describe('IncrementalSha1', () => {
  it('computes correct SHA1 for known input', async () => {
    const { IncrementalSha1 } = await import('./streams/hash.ts')
    const sha1 = new IncrementalSha1()
    await sha1.update(new TextEncoder().encode('hello'))
    const digest = await sha1.digest()
    expect(digest).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })

  it('handles multiple updates', async () => {
    const { IncrementalSha1, sha1Hex } = await import('./streams/hash.ts')
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
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.ts')
    expect(encodeFileName('photos/2026/cat.jpg')).toBe('photos/2026/cat.jpg')
    expect(encodeFileName('path with spaces')).toBe('path%20with%20spaces')
    expect(decodeFileName('path%20with%20spaces')).toBe('path with spaces')
  })

  it('handles unicode in file names', async () => {
    const { encodeFileName, decodeFileName } = await import('./raw/encoding.ts')
    const original = 'docs/日本語.txt'
    const encoded = encodeFileName(original)
    expect(encoded).not.toContain('日')
    expect(decodeFileName(encoded)).toBe(original)
  })
})
