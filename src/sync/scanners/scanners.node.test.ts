import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { syncTempFileName, syncTempRunId } from '../temp-files.ts'
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
const isDarwin = processLike?.platform === 'darwin'

/**
 * Advance the fake clock by 1 ms so the simulator assigns a distinct
 * uploadTimestamp to each file version. Call between successive uploads
 * or between an upload and a hide.
 */
function tick(): void {
  vi.advanceTimersByTime(1)
}

function makeB2FileVersion(
  name: string,
  ts = 1,
  action: FileAction = FileAction.Upload,
): FileVersion {
  return {
    accountId: 'acc' as unknown as AccountId,
    action,
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

  it('fails immediately when the local scan entry limit is exceeded', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'a')
    await writeFile(join(tmpDir, 'b.txt'), 'b')
    const errors: unknown[] = []

    const folder = new LocalFolder(tmpDir)

    await expect(
      collect<LocalSyncPath>(
        folder.scan({
          maxScanEntries: 1,
          onError: (event) => errors.push(event),
        }),
      ),
    ).rejects.toThrow('Sync scan entry limit exceeded')
    expect(errors).toEqual([])
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
    expect(errors[0]).toMatchObject({
      type: 'error',
      path: '',
      message: 'failed to scan local directory: ENOENT',
    })
    expect(JSON.stringify(errors[0])).not.toContain(tmpDir)
  })

  it('stops local scans when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop local scan'))
    await writeFile(join(tmpDir, 'file.txt'), 'content')

    const folder = new LocalFolder(tmpDir)
    await expect(
      collect<LocalSyncPath>(folder.scan({ signal: controller.signal })),
    ).rejects.toThrow('stop local scan')
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
      expect(errors[0]).toMatchObject({
        type: 'error',
        path: 'blocked',
      })
      expect((errors[0] as { readonly message?: string }).message).toMatch(
        /^failed to scan local directory: (EACCES|EPERM)$/,
      )
      expect(JSON.stringify(errors[0])).not.toContain(blockedDir)
    } finally {
      await chmod(blockedDir, 0o700).catch(() => {})
    }
  })

  it('applies include and exclude filters to relative paths', async () => {
    await mkdir(join(tmpDir, 'docs'), { recursive: true })
    await mkdir(join(tmpDir, 'cache'), { recursive: true })
    await writeFile(join(tmpDir, 'docs', 'readme.md'), 'readme')
    await writeFile(join(tmpDir, 'docs', 'draft.tmp'), 'draft')
    await writeFile(join(tmpDir, 'cache', 'artifact.md'), 'cache')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(
      folder.scan({
        include: ['**/*.md'],
        exclude: ['cache/**'],
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md'])
  })

  it.skipIf(isWindows || isDarwin)(
    'skips over-limit local paths for exclude-only RegExp filters',
    async () => {
      const deepSegments = Array.from({ length: 210 }, () => 'deep')
      const longRelativePath = ['secrets', ...deepSegments, 'file.txt'].join('/')
      const longDirectory = join(tmpDir, 'secrets', ...deepSegments)
      await mkdir(longDirectory, { recursive: true })
      await writeFile(join(longDirectory, 'file.txt'), 'secret')

      const skips: string[] = []
      const folder = new LocalFolder(tmpDir)
      const entries = await collect<LocalSyncPath>(
        folder.scan({
          exclude: [/^secrets\//],
          onSkip(event) {
            skips.push(`${event.reason}:${event.path}`)
          },
        }),
      )

      expect(entries.map((e) => e.relativePath)).toEqual([])
      expect(skips).toEqual([`path-too-long-for-regexp:${longRelativePath}`])
    },
  )

  it('does not prune descendants for exact slash-containing excludes', async () => {
    await mkdir(join(tmpDir, 'a', 'b'), { recursive: true })
    await mkdir(join(tmpDir, 'build', 'output'), { recursive: true })
    await mkdir(join(tmpDir, 'build', 'other'), { recursive: true })
    await writeFile(join(tmpDir, 'a', 'b', 'c.txt'), 'keep')
    await writeFile(join(tmpDir, 'build', 'output', 'app.js'), 'keep')
    await writeFile(join(tmpDir, 'build', 'other', 'app.js'), 'keep')

    const folder = new LocalFolder(tmpDir)
    const exactExcludeEntries = await collect<LocalSyncPath>(folder.scan({ exclude: ['a/b'] }))
    const includeExcludeEntries = await collect<LocalSyncPath>(
      folder.scan({ include: ['build/**'], exclude: ['build/output'] }),
    )

    expect(exactExcludeEntries.map((e) => e.relativePath)).toContain('a/b/c.txt')
    expect(includeExcludeEntries.map((e) => e.relativePath)).toEqual([
      'build/other/app.js',
      'build/output/app.js',
    ])
  })

  it('skips SDK partial download files while scanning', async () => {
    const tempPath = join(tmpDir, '.b2sdk-abandoned.partial')
    const previousTempPath = join(tmpDir, '.b2sdk-abandoned.partial.previous')
    await writeFile(tempPath, 'partial')
    await writeFile(previousTempPath, 'backup')
    await writeFile(join(tmpDir, 'keep.txt'), 'keep')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['keep.txt'])
    await expect(access(tempPath)).resolves.toBeFalsy()
    await expect(access(previousTempPath)).resolves.toBeFalsy()
  })

  it.skipIf(process.platform === 'win32')(
    'skips local filenames containing literal backslashes',
    async () => {
      await writeFile(join(tmpDir, 'a\\b.txt'), 'backslash')

      const folder = new LocalFolder(tmpDir)
      const skips: string[] = []
      const entries = await collect<LocalSyncPath>(
        folder.scan({
          onSkip(event) {
            skips.push(`${event.reason}:${event.path}`)
          },
        }),
      )

      expect(entries).toEqual([])
      expect(skips).toEqual(['unsafe-name:a\\b.txt'])
    },
  )

  it('scans directories with SDK partial download names', async () => {
    const partialDir = join(tmpDir, '.b2sdk-directory.partial')
    await mkdir(partialDir)
    await writeFile(join(partialDir, 'keep.txt'), 'keep')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['.b2sdk-directory.partial/keep.txt'])
    await expect(access(partialDir)).resolves.toBeFalsy()
  })

  it('skips reserved sync download temp directories', async () => {
    const reservedDir = syncTempFileName(
      '1234567890abcdef12345678',
      syncTempRunId(1234, '1234567890abcdef1234567890abcdef'),
    )
    await mkdir(join(tmpDir, reservedDir), { recursive: true })
    await writeFile(join(tmpDir, reservedDir, 'hidden.txt'), 'hidden')
    await writeFile(join(tmpDir, 'keep.txt'), 'keep')

    const folder = new LocalFolder(tmpDir)
    const entries = await collect<LocalSyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['keep.txt'])
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

  it('keeps Windows-reserved basenames available for B2 scans', async () => {
    const bucket = await client.createBucket({
      bucketName: 'reserved-name-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({ fileName: 'aux.txt', source: new BufferSource(enc.encode('aux')) })

    const folder = new B2Folder(bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['aux.txt'])
  })

  it('fails with a defined error when the B2 scan entry limit is exceeded', async () => {
    const bucket = await client.createBucket({
      bucketName: 'scan-limit-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({ fileName: 'a.txt', source: new BufferSource(enc.encode('a')) })
    await bucket.upload({ fileName: 'b.txt', source: new BufferSource(enc.encode('b')) })

    const folder = new B2Folder(bucket)
    await expect(collect<B2SyncPath>(folder.scan({ maxScanEntries: 1 }))).rejects.toThrow(
      'Sync scan entry limit exceeded',
    )
  })

  it('counts retained B2 versions for scan limits', async () => {
    const bucket = await client.createBucket({
      bucketName: 'scan-limit-versions-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({ fileName: 'a.txt', source: new BufferSource(enc.encode('a1')) })
    tick()
    await bucket.upload({ fileName: 'a.txt', source: new BufferSource(enc.encode('a2')) })

    const folder = new B2Folder(bucket)
    await expect(collect<B2SyncPath>(folder.scan({ maxScanEntries: 1 }))).rejects.toThrow(
      'Sync scan entry limit exceeded',
    )
    const entries = await collect<B2SyncPath>(folder.scan({ maxScanEntries: 2 }))

    expect(entries.map((entry) => entry.relativePath)).toEqual(['a.txt'])
    expect(entries[0]?.allVersions).toHaveLength(2)
  })

  it('counts excluded B2 versions against scan limits', async () => {
    const bucket = {
      async listFileVersions() {
        return {
          files: [makeB2FileVersion('skip-a.tmp', 1), makeB2FileVersion('skip-b.tmp', 2)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(bucket as unknown as Bucket)

    await expect(
      collect<B2SyncPath>(folder.scan({ exclude: ['*.tmp'], maxScanEntries: 1 })),
    ).rejects.toThrow('maxScanEntries=1')
  })

  it('counts unsafe B2 names against scan limits', async () => {
    const bucket = {
      async listFileVersions() {
        return {
          files: [makeB2FileVersion('unsafe/../a.txt', 1), makeB2FileVersion('unsafe/../b.txt', 2)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(bucket as unknown as Bucket)

    await expect(collect<B2SyncPath>(folder.scan({ maxScanEntries: 1 }))).rejects.toThrow(
      'maxScanEntries=1',
    )
  })

  it('counts over-returned outside-prefix B2 versions against scan limits', async () => {
    const bucket = {
      async listFileVersions() {
        return {
          files: [makeB2FileVersion('other/a.txt', 1), makeB2FileVersion('other/b.txt', 2)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }
    const folder = new B2Folder(bucket as unknown as Bucket, 'root/')

    await expect(collect<B2SyncPath>(folder.scan({ maxScanEntries: 1 }))).rejects.toThrow(
      'maxScanEntries=1',
    )
  })

  it('stops B2 scans before the next page when the signal aborts', async () => {
    function makeFileVersion(name: string): FileVersion {
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
        uploadTimestamp: 1,
      }
    }

    const controller = new AbortController()
    const calls: Array<{ startFileName?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { startFileName?: string }) {
        calls.push({
          ...(opts?.startFileName !== undefined ? { startFileName: opts.startFileName } : {}),
        })
        controller.abort(new Error('stop scan'))
        return {
          files: [makeFileVersion('first.txt')],
          nextFileName: 'second.txt',
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    await expect(collect<B2SyncPath>(folder.scan({ signal: controller.signal }))).resolves.toEqual(
      [],
    )
    expect(calls).toEqual([{}])
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
    // server-side, so B2Folder also guards against out-of-prefix names
    // client-side before stripping the prefix.
    const photosFolder = new B2Folder(bucket, 'photos/')
    const photoEntries = await collect<B2SyncPath>(photosFolder.scan())

    // The prefix is stripped from the relative paths
    expect(photoEntries.map((e) => e.relativePath)).toEqual(['cat.jpg', 'dog.jpg'])

    const docsFolder = new B2Folder(bucket, 'docs/')
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

  it('applies include and exclude filters after stripping the prefix', async () => {
    const bucket = await client.createBucket({
      bucketName: 'filter-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'backup/docs/readme.md',
      source: new BufferSource(enc.encode('readme')),
    })
    tick()
    await bucket.upload({
      fileName: 'backup/docs/draft.tmp',
      source: new BufferSource(enc.encode('draft')),
    })
    tick()
    await bucket.upload({
      fileName: 'backup/cache/artifact.md',
      source: new BufferSource(enc.encode('cache')),
    })

    const folder = new B2Folder(bucket, 'backup/')
    const entries = await collect<B2SyncPath>(
      folder.scan({
        include: ['**/*.md'],
        exclude: ['cache/**'],
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md'])
  })

  it('keeps B2 descendants for exact slash-containing excludes', async () => {
    const bucket = await client.createBucket({
      bucketName: 'exact-exclude-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'backup/a/b/c.txt',
      source: new BufferSource(enc.encode('keep')),
    })
    tick()
    await bucket.upload({
      fileName: 'backup/build/output/app.js',
      source: new BufferSource(enc.encode('keep')),
    })
    tick()
    await bucket.upload({
      fileName: 'backup/build/other/app.js',
      source: new BufferSource(enc.encode('keep')),
    })

    const folder = new B2Folder(bucket, 'backup/')
    const exactExcludeEntries = await collect<B2SyncPath>(folder.scan({ exclude: ['a/b'] }))
    const includeExcludeEntries = await collect<B2SyncPath>(
      folder.scan({ include: ['build/**'], exclude: ['build/output'] }),
    )

    expect(exactExcludeEntries.map((e) => e.relativePath)).toContain('a/b/c.txt')
    expect(includeExcludeEntries.map((e) => e.relativePath)).toEqual([
      'build/other/app.js',
      'build/output/app.js',
    ])
  })

  it('does not yield leading slashes when prefix omits its trailing slash', async () => {
    const bucket = await client.createBucket({
      bucketName: 'prefix-normalize-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'backupfile.txt',
      source: new BufferSource(enc.encode('raw-prefix')),
    })
    tick()
    await bucket.upload({
      fileName: 'backup/docs/readme.md',
      source: new BufferSource(enc.encode('readme')),
    })

    const folder = new B2Folder(bucket, 'backup')
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md', 'file.txt'])
  })

  it('rejects multi-slash suffixes after a slashless raw prefix', async () => {
    function makeFileVersion(fileName: string, uploadTimestamp: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${uploadTimestamp}` as unknown as FileId,
        fileInfo: {},
        fileName,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp,
      }
    }

    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            makeFileVersion('backup/docs/readme.md', 1),
            makeFileVersion('backup//docs/ambiguous.md', 2),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket, 'backup')
    const skips: string[] = []
    const entries = await collect<B2SyncPath>(
      folder.scan({
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md'])
    expect(skips).toEqual(['unsafe-name:backup//docs/ambiguous.md'])
  })

  it('reports leading-slash B2 names without a raw prefix as unsafe', async () => {
    const fileVersion: FileVersion = {
      accountId: 'acc' as unknown as AccountId,
      action: FileAction.Upload,
      bucketId: 'b' as unknown as BucketId,
      contentLength: 1,
      contentMd5: null,
      contentSha1: 'sha1',
      contentType: 'application/octet-stream',
      fileId: 'fid' as unknown as FileId,
      fileInfo: {},
      fileName: '/docs\\readme.md',
      fileRetention: { isClientAuthorizedToRead: true, value: null },
      legalHold: { isClientAuthorizedToRead: true, value: null },
      replicationStatus: null,
      serverSideEncryption: { mode: EncryptionMode.None },
      uploadTimestamp: 1,
    }
    const mockBucket = {
      async listFileVersions() {
        return {
          files: [fileVersion],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const skips: string[] = []
    const entries = await collect<B2SyncPath>(
      folder.scan({
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual([])
    expect(skips).toEqual(['unsafe-name:/docs\\readme.md'])
  })

  it('reports odd B2 names while yielding valid files', async () => {
    function makeFileVersion(
      fileName: string,
      uploadTimestamp: number,
      action: FileAction = FileAction.Upload,
    ): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: 'fid' as unknown as FileId,
        fileInfo: {},
        fileName,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp,
      }
    }

    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            makeFileVersion('valid.txt', 1),
            makeFileVersion('dir/', 2),
            makeFileVersion('a//b', 3),
            makeFileVersion('../secret.txt', 4),
            makeFileVersion('docs/./readme.md', 5),
            makeFileVersion('.well-known/config', 6),
            makeFileVersion('hidden//marker', 7, FileAction.Hide),
            makeFileVersion('notes.txt:hidden.exe', 8),
            makeFileVersion('dir/C:/x', 9),
            makeFileVersion('CON', 10),
            makeFileVersion('trailing.', 11),
            makeFileVersion('trailing ', 12),
            makeFileVersion('bad\u0001name.txt', 13),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const skips: string[] = []
    const entries = await collect<B2SyncPath>(
      folder.scan({
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual([
      '.well-known/config',
      'CON',
      'dir/C:/x',
      'notes.txt:hidden.exe',
      'trailing ',
      'trailing.',
      'valid.txt',
    ])
    expect(skips).toEqual([
      'unsafe-name:dir/',
      'unsafe-name:a//b',
      'unsafe-name:../secret.txt',
      'unsafe-name:docs/./readme.md',
      'unsafe-name:hidden//marker',
      'unsafe-name:bad\u0001name.txt',
    ])
  })

  it('skips Windows-dangerous B2 names when local path safety is required', async () => {
    function makeFileVersion(fileName: string, uploadTimestamp: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${uploadTimestamp}` as unknown as FileId,
        fileInfo: {},
        fileName,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp,
      }
    }

    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            makeFileVersion('safe.txt', 1),
            makeFileVersion('name:stream', 2),
            makeFileVersion('AUX.txt', 3),
            makeFileVersion('CONIN$', 4),
            makeFileVersion('COM0.txt', 5),
            makeFileVersion('nul.tar.gz', 6),
            makeFileVersion('dir/C:/x', 7),
            makeFileVersion('trailing.', 8),
            makeFileVersion('trailing ', 9),
            makeFileVersion('Readme.txt', 10),
            makeFileVersion('README.txt', 11),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const skips: string[] = []
    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(
      folder.scan({
        requireLocalSafePaths: true,
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((e) => e.relativePath)).toEqual(['safe.txt'])
    expect(skips).toEqual([
      'local-unsafe-name:name:stream',
      'local-unsafe-name:AUX.txt',
      'local-unsafe-name:CONIN$',
      'local-unsafe-name:COM0.txt',
      'local-unsafe-name:nul.tar.gz',
      'local-unsafe-name:dir/C:/x',
      'local-unsafe-name:trailing.',
      'local-unsafe-name:trailing ',
      'local-path-collision:Readme.txt',
      'local-path-collision:README.txt',
    ])
  })

  it('skips long B2 paths for exclude-only RegExp filters', async () => {
    const longRelativePath = `${'deep/'.repeat(205)}file.txt`
    const fileVersion: FileVersion = {
      accountId: 'acc' as unknown as AccountId,
      action: FileAction.Upload,
      bucketId: 'b' as unknown as BucketId,
      contentLength: 1,
      contentMd5: null,
      contentSha1: 'sha1',
      contentType: 'application/octet-stream',
      fileId: 'fid_long' as unknown as FileId,
      fileInfo: {},
      fileName: longRelativePath,
      fileRetention: { isClientAuthorizedToRead: true, value: null },
      legalHold: { isClientAuthorizedToRead: true, value: null },
      replicationStatus: null,
      serverSideEncryption: { mode: EncryptionMode.None },
      uploadTimestamp: 1,
    }
    const mockBucket = {
      async listFileVersions() {
        return {
          files: [fileVersion],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const skips: string[] = []
    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(
      folder.scan({
        exclude: [/\.bak$/],
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((entry) => entry.relativePath)).toEqual([])
    expect(skips).toEqual([`path-too-long-for-regexp:${longRelativePath}`])
  })

  it('continues scanning when onSkip throws', async () => {
    function makeFileVersion(name: string, ts: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${ts}` as unknown as FileId,
        fileInfo: {},
        fileName: name,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: ts,
      }
    }
    const mockBucket = {
      async listFileVersions() {
        return {
          files: [makeFileVersion('docs/./bad.txt', 1), makeFileVersion('valid.txt', 2)],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(
      folder.scan({
        onSkip() {
          throw new Error('logging failed')
        },
      }),
    )

    expect(entries.map((entry) => entry.relativePath)).toEqual(['valid.txt'])
  })

  it('rejects all B2 keys that collide after relative path normalization', async () => {
    function makeFileVersion(name: string, ts: number): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${ts}` as unknown as FileId,
        fileInfo: {},
        fileName: name,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: ts,
      }
    }

    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            makeFileVersion('docs\\readme.md', 1),
            makeFileVersion('docs/readme.md', 2),
            makeFileVersion('docs\\readme.md', 3),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const skips: string[] = []
    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(
      folder.scan({
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(entries.map((e) => e.selectedVersion.fileName)).toEqual([])
    expect(skips).toEqual([
      'relative-path-collision:docs\\readme.md',
      'relative-path-collision:docs/readme.md',
    ])
  })

  it('does not let hidden collision markers suppress visible objects', async () => {
    function makeFileVersion(
      name: string,
      ts: number,
      action: FileAction = FileAction.Upload,
    ): FileVersion {
      return {
        accountId: 'acc' as unknown as AccountId,
        action,
        bucketId: 'b' as unknown as BucketId,
        contentLength: 1,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: `fid_${ts}` as unknown as FileId,
        fileInfo: {},
        fileName: name,
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: ts,
      }
    }

    const mockBucket = {
      async listFileVersions() {
        return {
          files: [
            makeFileVersion('docs\\readme.md', 2, FileAction.Hide),
            makeFileVersion('docs/readme.md', 1, FileAction.Upload),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(folder.scan())

    expect(entries.map((e) => e.selectedVersion.fileName)).toEqual(['docs/readme.md'])
  })

  it('does not push include prefixes past slashless raw B2 prefixes', async () => {
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

    const calls: Array<{ prefix?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { prefix?: string }) {
        calls.push({
          ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
        })
        return {
          files: [
            makeFileVersion('backup/docs/readme.md', 1),
            makeFileVersion('backupcache/other.md', 2),
            makeFileVersion('backup/cache/skip.md', 3),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket, 'backup')
    const entries = await collect<B2SyncPath>(folder.scan({ include: ['docs/**'] }))

    expect(calls).toEqual([{ prefix: 'backup' }])
    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md'])
  })

  it('pushes down safe include prefixes while filtering listed names', async () => {
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

    const calls: Array<{ prefix?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { prefix?: string }) {
        calls.push({
          ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
        })
        return {
          files: [
            makeFileVersion('root/active', 4),
            makeFileVersion('root/active/keep.txt', 1),
            makeFileVersion('root/active/skip.tmp', 2),
            makeFileVersion('root/active2/leak.txt', 5),
            makeFileVersion('root/archive/old.txt', 3),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket, 'root/')
    const entries = await collect<B2SyncPath>(
      folder.scan({
        include: ['active/**'],
        exclude: ['*.tmp'],
      }),
    )

    expect(calls).toEqual([{ prefix: 'root/active' }])
    expect(entries.map((e) => e.relativePath)).toEqual(['active', 'active/keep.txt'])
  })

  it('does not push include prefixes past normalized separator positions', async () => {
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

    const files = [
      makeFileVersion('docs\\readme.md', 1),
      makeFileVersion('docs/guide.md', 2),
      makeFileVersion('other/readme.md', 3),
    ]
    const calls: Array<{ prefix?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { prefix?: string }) {
        calls.push({
          ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
        })
        return {
          files:
            opts?.prefix === undefined
              ? files
              : files.filter((file) => file.fileName.startsWith(opts.prefix ?? '')),
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const folder = new B2Folder(mockBucket as unknown as Bucket)
    const entries = await collect<B2SyncPath>(
      folder.scan({
        include: ['docs/readme.md'],
      }),
    )

    expect(calls).toEqual([{ prefix: 'docs' }])
    expect(entries.map((e) => e.relativePath)).toEqual(['docs/readme.md'])
  })

  it('preserves backslashes in raw B2 prefixes', async () => {
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

    const calls: Array<{ prefix?: string }> = []
    const mockBucket = {
      async listFileVersions(opts?: { prefix?: string }) {
        calls.push({
          ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
        })
        return {
          files: [
            makeFileVersion('root\\active', 1),
            makeFileVersion('root\\active/keep.txt', 2),
            makeFileVersion('root/active/wrong-prefix.txt', 3),
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
    }

    const skips: string[] = []
    const folder = new B2Folder(mockBucket as unknown as Bucket, 'root\\')
    const entries = await collect<B2SyncPath>(
      folder.scan({
        include: ['active/**'],
        onSkip(event) {
          skips.push(`${event.reason}:${event.b2FileName}`)
        },
      }),
    )

    expect(calls).toEqual([{ prefix: 'root\\' }])
    expect(entries.map((e) => e.relativePath)).toEqual(['active', 'active/keep.txt'])
    expect(skips).toEqual(['outside-prefix:root/active/wrong-prefix.txt'])
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

  it('fails when B2 pagination continuation tokens do not advance', async () => {
    const errors: string[] = []
    const mockBucket = {
      async listFileVersions() {
        return {
          files: [],
          nextFileName: 'same.txt',
          nextFileId: 'fid_same.txt',
        }
      },
    }
    const folder = new B2Folder(mockBucket as unknown as Bucket)

    await expect(
      collect<B2SyncPath>(
        folder.scan({
          onError(event) {
            errors.push(event.message)
          },
        }),
      ),
    ).rejects.toThrow('B2 pagination did not advance')
    expect(errors).toContain('failed to scan B2 file versions: B2 pagination did not advance')
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
