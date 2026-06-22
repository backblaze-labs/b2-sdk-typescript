import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../../bucket.ts'
import type { B2Client } from '../../client.ts'
import { BufferSource } from '../../streams/source.ts'
import { makeClient } from '../../test-utils/index.ts'
import { BucketType } from '../../types/bucket.ts'
import { EncryptionMode } from '../../types/encryption.ts'
import { FileAction, type FileVersion } from '../../types/file.ts'
import type { AccountId, BucketId, FileId } from '../../types/ids.ts'
import type { B2SyncPath, LocalSyncPath } from '../types.ts'
import { B2Folder } from './b2.ts'
import { LocalFolder } from './local.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) {
    items.push(item)
  }
  return items
}

const enc = new TextEncoder()
const processLike = (globalThis as { process?: { platform?: string } }).process
const isWindows = processLike?.platform === 'win32'

/**
 * Advance the fake clock by 1 ms so the simulator assigns a distinct
 * uploadTimestamp to each file version. Call between successive uploads
 * or between an upload and a hide.
 */
function tick(): void {
  vi.advanceTimersByTime(1)
}

// ---------------------------------------------------------------------------
// LocalFolder
// ---------------------------------------------------------------------------

describe('LocalFolder', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'localfolder-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('scans a flat directory and yields entries sorted by relative path', async () => {
    await writeFile(join(tmpDir, 'charlie.txt'), 'c')
    await writeFile(join(tmpDir, 'alpha.txt'), 'a')
    await writeFile(join(tmpDir, 'Zed.txt'), 'z')
    await writeFile(join(tmpDir, 'bravo.txt'), 'b')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual([
      'Zed.txt',
      'alpha.txt',
      'bravo.txt',
      'charlie.txt',
    ])

    // Verify each entry has the expected properties
    for (const entry of entries) {
      expect(entry.absolutePath).toContain(tmpDir)
      expect(entry.size).toBeGreaterThan(0)
      expect(entry.modTimeMillis).toBeGreaterThan(0)
    }
  })

  it('scans nested directories recursively', async () => {
    await mkdir(join(tmpDir, 'sub', 'deep'), { recursive: true })
    await writeFile(join(tmpDir, 'root.txt'), 'root')
    await writeFile(join(tmpDir, 'sub', 'middle.txt'), 'mid')
    await writeFile(join(tmpDir, 'sub', 'deep', 'leaf.txt'), 'leaf')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual([
      'root.txt',
      'sub/deep/leaf.txt',
      'sub/middle.txt',
    ])
  })

  it('yields empty iterator for an empty directory', async () => {
    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries).toEqual([])
  })

  it('surfaces non-existent root scan errors', async () => {
    const folder = new LocalFolder(join(tmpDir, 'does-not-exist'))
    const errors: unknown[] = []

    await expect(
      collect<LocalSyncPath>(
        folder.scan({
          onError: (event) => errors.push(event),
        }),
      ),
    ).rejects.toThrow('failed to scan local directory')
    expect(errors).toContainEqual(
      expect.objectContaining({
        type: 'error',
        path: '',
        message: expect.stringContaining('failed to scan local directory'),
      }),
    )
  })

  it('uses forward slashes in relative paths even on the current platform', async () => {
    await mkdir(join(tmpDir, 'a', 'b'), { recursive: true })
    await writeFile(join(tmpDir, 'a', 'b', 'file.txt'), 'content')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries).toHaveLength(1)
    expect(entries[0]?.relativePath).toBe('a/b/file.txt')
    expect(entries[0]?.relativePath).not.toContain('\\')
  })

  it.skipIf(isWindows)('continues scanning after an unreadable subdirectory', async () => {
    const { chmod } = await import('node:fs/promises')
    const blockedDir = join(tmpDir, 'blocked')
    await mkdir(blockedDir)
    await writeFile(join(tmpDir, 'readable.txt'), 'ok')
    await chmod(blockedDir, 0)
    const errors: unknown[] = []

    try {
      const folder = new LocalFolder(tmpDir)
      const entries = await collect<LocalSyncPath>(
        folder.scan({
          onError: (event) => errors.push(event),
        }),
      )

      expect(entries.map((entry) => entry.relativePath)).toEqual(['readable.txt'])
      expect(errors).toContainEqual(
        expect.objectContaining({
          type: 'error',
          path: 'blocked',
          message: expect.stringContaining('failed to scan local directory'),
        }),
      )
    } finally {
      await chmod(blockedDir, 0o700).catch(() => {})
    }
  })
})

// ---------------------------------------------------------------------------
// B2Folder
// ---------------------------------------------------------------------------

describe('B2Folder', () => {
  let client: B2Client

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now() })
    ;({ client } = makeClient())
    await client.authorize()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scans an empty bucket and yields nothing', async () => {
    const bucket = await client.createBucket({
      bucketName: 'empty-bucket',
      bucketType: BucketType.AllPrivate,
    })

    const folder = new B2Folder(bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries).toEqual([])
  })

  it('stops B2 pagination when aborted after a page', async () => {
    const controller = new AbortController()
    const listFileVersions = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { files: [], nextFileName: 'next', nextFileId: 'next-id' }
    })
    const folder = new B2Folder({ listFileVersions } as unknown as Bucket)

    const entries = await collect<B2SyncPath>(folder.scan({ signal: controller.signal }))

    expect(entries).toEqual([])
    expect(listFileVersions).toHaveBeenCalledTimes(1)
  })

  it('surfaces B2 listing errors', async () => {
    const listFileVersions = vi.fn().mockRejectedValue(new Error('temporary outage'))
    const errors: unknown[] = []
    const folder = new B2Folder({ listFileVersions } as unknown as Bucket)

    await expect(
      collect<B2SyncPath>(
        folder.scan({
          onError: (event) => errors.push(event),
        }),
      ),
    ).rejects.toThrow('failed to scan B2 file versions')
    expect(errors).toContainEqual(
      expect.objectContaining({
        type: 'error',
        path: '',
        message: 'failed to scan B2 file versions: temporary outage',
      }),
    )
  })

  it('stops cleanly when a B2 list request is aborted', async () => {
    const controller = new AbortController()
    const listFileVersions = vi.fn().mockImplementation(
      (options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
          controller.abort()
        }),
    )
    const errors: unknown[] = []
    const folder = new B2Folder({ listFileVersions } as unknown as Bucket)

    const entries = await collect<B2SyncPath>(
      folder.scan({
        signal: controller.signal,
        onError: (event) => errors.push(event),
      }),
    )

    expect(entries).toEqual([])
    expect(listFileVersions).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    )
    expect(errors).toEqual([])
  })

  it('scans a bucket with files and yields them sorted by name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'sorted-bucket',
      bucketType: BucketType.AllPrivate,
    })

    // Upload in non-alphabetical order
    await bucket.upload({ fileName: 'zebra.txt', source: new BufferSource(enc.encode('z')) })
    tick()
    await bucket.upload({ fileName: 'Zebra.txt', source: new BufferSource(enc.encode('Z')) })
    tick()
    await bucket.upload({ fileName: 'apple.txt', source: new BufferSource(enc.encode('a')) })
    tick()
    await bucket.upload({ fileName: 'mango.txt', source: new BufferSource(enc.encode('m')) })

    const folder = new B2Folder(bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual([
      'Zebra.txt',
      'apple.txt',
      'mango.txt',
      'zebra.txt',
    ])

    // Verify each entry has the expected properties
    for (const entry of entries) {
      expect(entry.size).toBeGreaterThan(0)
      expect(entry.modTimeMillis).toBeGreaterThan(0)
      expect(entry.selectedVersion).toBeDefined()
      expect(entry.allVersions.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('excludes hidden files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hide-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({ fileName: 'keep.txt', source: new BufferSource(enc.encode('keep')) })
    tick()
    await bucket.upload({
      fileName: 'hidden.txt',
      source: new BufferSource(enc.encode('will hide')),
    })
    tick()
    await bucket.hideFile('hidden.txt')

    const folder = new B2Folder(bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['keep.txt'])
  })

  it('groups multiple versions and picks the latest', async () => {
    const bucket = await client.createBucket({
      bucketName: 'version-bucket',
      bucketType: BucketType.AllPrivate,
    })

    // Upload the same file three times to create multiple versions.
    // Advance the fake clock between each upload so each gets a distinct timestamp.
    await bucket.upload({ fileName: 'doc.txt', source: new BufferSource(enc.encode('v1')) })
    tick()
    await bucket.upload({ fileName: 'doc.txt', source: new BufferSource(enc.encode('v2--')) })
    tick()
    await bucket.upload({
      fileName: 'doc.txt',
      source: new BufferSource(enc.encode('v3------')),
    })

    const folder = new B2Folder(bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (!entry) throw new Error('expected at least one entry')
    expect(entry.relativePath).toBe('doc.txt')

    // The selected version should be the latest (largest content = v3)
    expect(entry.selectedVersion.contentLength).toBe(enc.encode('v3------').byteLength)

    // All three versions should be tracked
    expect(entry.allVersions).toHaveLength(3)

    // Versions should be sorted newest first (descending uploadTimestamp)
    for (let i = 1; i < entry.allVersions.length; i++) {
      const prev = entry.allVersions[i - 1]
      const curr = entry.allVersions[i]
      expect(prev?.uploadTimestamp).toBeGreaterThan(curr?.uploadTimestamp ?? 0)
    }
  })

  it('respects prefix filtering', async () => {
    const bucket = await client.createBucket({
      bucketName: 'prefix-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'photos/cat.jpg',
      source: new BufferSource(enc.encode('cat')),
    })
    tick()
    await bucket.upload({
      fileName: 'photos/dog.jpg',
      source: new BufferSource(enc.encode('dog')),
    })
    tick()
    await bucket.upload({
      fileName: 'docs/readme.md',
      source: new BufferSource(enc.encode('readme')),
    })
    tick()
    await bucket.upload({
      fileName: 'docs/guide.md',
      source: new BufferSource(enc.encode('guide')),
    })

    // Scan with "photos/" prefix. The simulator does not filter by prefix
    // server-side, so B2Folder receives all files. It strips the prefix from
    // file names to compute relativePath. Files that do not start with the
    // prefix still appear because the simulator returns them, but their
    // relativePath will be the full fileName with the prefix length sliced off
    // (a known simulator limitation). To test prefix handling in isolation,
    // use a bucket that only contains files under the target prefix.
    const photosBucket = await client.createBucket({
      bucketName: 'photos-only',
      bucketType: BucketType.AllPrivate,
    })
    await photosBucket.upload({
      fileName: 'photos/cat.jpg',
      source: new BufferSource(enc.encode('cat')),
    })
    tick()
    await photosBucket.upload({
      fileName: 'photos/dog.jpg',
      source: new BufferSource(enc.encode('dog')),
    })

    const photosFolder = new B2Folder(photosBucket, 'photos/')
    const photoEntries = await collect<B2SyncPath>(photosFolder.scan())

    // The prefix is stripped from the relative paths
    expect(photoEntries.map((e) => e.relativePath)).toEqual(['cat.jpg', 'dog.jpg'])

    // Similarly for docs
    const docsBucket = await client.createBucket({
      bucketName: 'docs-only',
      bucketType: BucketType.AllPrivate,
    })
    await docsBucket.upload({
      fileName: 'docs/guide.md',
      source: new BufferSource(enc.encode('guide')),
    })
    tick()
    await docsBucket.upload({
      fileName: 'docs/readme.md',
      source: new BufferSource(enc.encode('readme')),
    })

    const docsFolder = new B2Folder(docsBucket, 'docs/')
    const docEntries = await collect<B2SyncPath>(docsFolder.scan())

    expect(docEntries.map((e) => e.relativePath)).toEqual(['guide.md', 'readme.md'])

    // Scan without prefix yields full file names as relative paths
    const allFolder = new B2Folder(bucket)
    const allEntries = await collect<B2SyncPath>(allFolder.scan())

    expect(allEntries).toHaveLength(4)
    expect(allEntries.map((e) => e.relativePath)).toEqual([
      'docs/guide.md',
      'docs/readme.md',
      'photos/cat.jpg',
      'photos/dog.jpg',
    ])
  })

  // Pagination: when listFileVersions returns nextFileName, B2Folder must
  // continue the loop with startFileName + startFileId until the server runs
  // out of pages. The simulator's default page size is large enough that real
  // tests don't trigger pagination, so we drive it with a mock bucket.
  it('paginates through listFileVersions until nextFileName is null', async () => {
    function makeFileVersion(name: string, ts: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${name}` as unknown as FileId,
        fileInfo: {},
        fileName: name,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: ts,
      }
    }
    const calls: Array<{ startFileName?: string; startFileId?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { startFileName?: string; startFileId?: string }) {
        calls.push({
          ...(opts?.startFileName !== undefined ? { startFileName: opts.startFileName } : {}),
          ...(opts?.startFileId !== undefined ? { startFileId: opts.startFileId } : {}),
        })
        if (opts?.startFileName === undefined) {
          return {
            files: [makeFileVersion('a.txt', 1), makeFileVersion('b.txt', 2)],
            nextFileName: 'c.txt',
            nextFileId: 'fid_c.txt',
          }
        }
        return {
          files: [makeFileVersion('c.txt', 3), makeFileVersion('d.txt', 4)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    // Two paginated calls: first without a cursor, second with the cursor returned.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({})
    expect(calls[1]).toEqual({ startFileName: 'c.txt', startFileId: 'fid_c.txt' })
  })

  // Edge: the second page returns nextFileName but nextFileId === null (rare
  // but allowed by the API). The continuation must omit startFileId.
  it('continues paginating when nextFileId is null', async () => {
    function makeFileVersion(name: string, ts: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${name}` as unknown as FileId,
        fileInfo: {},
        fileName: name,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: ts,
      }
    }
    const calls: Array<{ startFileName?: string; startFileId?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { startFileName?: string; startFileId?: string }) {
        calls.push({
          ...(opts?.startFileName !== undefined ? { startFileName: opts.startFileName } : {}),
          ...(opts?.startFileId !== undefined ? { startFileId: opts.startFileId } : {}),
        })
        if (opts?.startFileName === undefined) {
          return {
            files: [makeFileVersion('a.txt', 1)],
            nextFileName: 'b.txt',
            nextFileId: null,
          }
        }
        return {
          files: [makeFileVersion('b.txt', 2)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['a.txt', 'b.txt'])
    // The continuation forwards startFileName but omits startFileId when the
    // server reports a null nextFileId.
    expect(calls[1]?.startFileName).toBe('b.txt')
    expect(calls[1]?.startFileId).toBeUndefined()
  })

  it('keeps malformed B2 contentSha1 as untrusted scan metadata', async () => {
    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            {
              accountId: 'acc' as unknown as AccountId,
              action: FileAction.Upload,
              bucketId: 'b' as unknown as BucketId,
              contentLength: 1,
              contentMd5: null,
              contentSha1: 'not-a-sha1',
              contentType: 'application/octet-stream',
              fileId: 'fid_bad' as unknown as FileId,
              fileInfo: {},
              fileName: 'bad.txt',
              fileRetention: { isClientAuthorizedToRead: true, value: null },
              legalHold: { isClientAuthorizedToRead: true, value: null },
              replicationStatus: null,
              serverSideEncryption: { mode: EncryptionMode.None },
              uploadTimestamp: 1,
            },
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(mockBucket as unknown as Bucket)

    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries[0]?.contentSha1).toBe('not-a-sha1')
  })
})
