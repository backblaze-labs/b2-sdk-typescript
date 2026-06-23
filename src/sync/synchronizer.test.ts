import { describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { sha1Hex } from '../streams/hash.ts'
import { daysFromNow } from '../test-utils/index.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { localFileIoTestHooks, writeLocalStreamInsideRoot } from './local-file-io.ts'
import { compareSyncRelativePaths } from './path-order.ts'
import { B2Folder } from './scanners/b2.ts'
import type {
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize, synchronizerTestHooks } from './synchronizer.ts'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncCompareEvent,
  SyncEncryptionProvider,
  SyncEvent,
  SyncFolder,
  SyncPath,
  SyncScanOptions,
} from './types.ts'

const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'
const processLike = (globalThis as { process?: { platform?: string } }).process
const isWindows = processLike?.platform === 'win32'
const isDarwin = processLike?.platform === 'darwin'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLocalSyncPath(
  relativePath: string,
  modTimeMillis: number,
  size: number,
): LocalSyncPath {
  return { relativePath, modTimeMillis, size, absolutePath: `/tmp/${relativePath}` }
}

function makeB2SyncPath(
  relativePath: string,
  modTimeMillis: number,
  size: number,
  /** Full B2 key (with prefix). Defaults to `relativePath` for the no-prefix case. */
  b2FileName?: string,
  contentSha1: string | null = 'sha1',
  fileInfo: Record<string, string> = {},
  pathContentSha1: string | null | undefined = contentSha1,
): B2SyncPath {
  const fv: FileVersion = {
    accountId: 'acc' as unknown as AccountId,
    action: FileAction.Upload,
    bucketId: 'bucket' as unknown as BucketId,
    contentLength: size,
    contentMd5: null,
    contentSha1,
    contentType: 'application/octet-stream',
    fileId: `fid_${relativePath}` as unknown as FileId,
    fileInfo,
    fileName: b2FileName ?? relativePath,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: { mode: EncryptionMode.None },
    uploadTimestamp: modTimeMillis,
  }
  return {
    relativePath,
    modTimeMillis,
    size,
    ...(pathContentSha1 !== undefined ? { contentSha1: pathContentSha1 } : {}),
    selectedVersion: fv,
    allVersions: [fv],
  }
}

function makeMemoryFolder(files: SyncPath[], type: 'local' | 'b2' = 'local'): SyncFolder {
  return {
    type,
    appliesScanSorting: true,
    async *scan() {
      const sorted = [...files].sort((a, b) =>
        compareSyncRelativePaths(a.relativePath, b.relativePath),
      )
      for (const f of sorted) yield f
    },
  }
}

/** Collects all events from the synchronize async generator. */
async function collectEvents(config: SynchronizerConfig): Promise<SyncEvent[]> {
  const events: SyncEvent[] = []
  for await (const ev of synchronize(config)) {
    events.push(ev)
  }
  return events
}

function isCompareEvent(event: SyncEvent): event is SyncCompareEvent {
  return event.type === 'compare'
}

function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })
}

function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

// A minimal mock bucket that records calls but does not perform real I/O.
function makeMockBucket(downloads: Record<string, Uint8Array> = {}) {
  const downloadById = vi.fn().mockImplementation((fileId: string) => ({
    body: streamFromBytes(downloads[fileId] ?? new Uint8Array([1, 2, 3])),
  }))
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockImplementation((fileName: string) => ({
      body: streamFromBytes(downloads[fileName] ?? new Uint8Array([1, 2, 3])),
    })),
    file: vi.fn().mockImplementation(() => ({ downloadById })),
    downloadById,
    copyFile: vi.fn().mockResolvedValue(undefined),
    hideFile: vi.fn().mockResolvedValue(undefined),
    deleteFileVersion: vi.fn().mockResolvedValue(undefined),
    listFileVersions: vi.fn().mockResolvedValue({ files: [], nextFileName: null }),
  }
}

function deferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synchronize', () => {
  describe('direction resolution', () => {
    it('resolves local-to-b2 direction (upload)', async () => {
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([], 'b2')
      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }
      // Should not throw; produces no actions for empty folders.
      const events = await collectEvents(config)
      expect(events).toEqual([])
    })

    it('resolves b2-to-local direction (download)', async () => {
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([], 'local')
      const config: SynchronizerDownConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'local', root: '/tmp/dest' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
      }
      const events = await collectEvents(config)
      expect(events).toEqual([])
    })

    it('resolves b2-to-b2 direction (copy)', async () => {
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([], 'b2')
      const config: SynchronizerConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
      }
      const events = await collectEvents(config)
      expect(events).toEqual([])
    })

    it('throws on unsupported direction (local-to-local)', async () => {
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([], 'local')
      const config: SynchronizerConfig = {
        source: { ...source, type: 'local' },
        dest: { ...dest, type: 'local' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
      }
      await expect(collectEvents(config)).rejects.toThrow(
        'Unsupported sync direction: local to local',
      )
    })
  })

  describe('compare events', () => {
    it('yields a compare event for each paired file', async () => {
      const sourceFile = makeLocalSyncPath('a.txt', 1000, 100)
      const destFile = makeB2SyncPath('a.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const compareEvents = events.filter((e) => e.type === 'compare')
      expect(compareEvents).toHaveLength(1)
      expect(compareEvents[0]?.path).toBe('a.txt')
    })

    it('yields compare events for source-only and dest-only files', async () => {
      const sourceFile = makeLocalSyncPath('new.txt', 2000, 50)
      const destFile = makeB2SyncPath('old.txt', 1000, 80)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const compareEvents = events.filter((e) => e.type === 'compare')
      // Two files: one source-only ('new.txt'), one dest-only ('old.txt')
      expect(compareEvents).toHaveLength(2)
    })

    it('schedules actions from full sha1 compare batches', async () => {
      const source = makeMemoryFolder(
        [makeLocalSyncPath('a.txt', 1000, 10), makeLocalSyncPath('b.txt', 1000, 20)],
        'local',
      )
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'sha1',
          keepMode: 'no-delete',
          concurrency: 1,
          dryRun: true,
        },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events.filter((e) => e.type === 'compare')).toHaveLength(2)
      expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(2)
    })

    it('waits for the scan to finish before starting actions', async () => {
      const first = makeB2SyncPath('a.txt', 1000, 10)
      const second = makeB2SyncPath('b.txt', 1000, 20)
      let releaseSecond = () => {}
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      const source: SyncFolder = {
        type: 'b2',
        appliesScanSorting: true,
        async *scan() {
          yield first
          await secondGate
          yield second
        },
      }
      const dest = makeMemoryFolder([], 'b2')
      const mockBucket = makeMockBucket()
      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 1 },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const gen = synchronize(config)
      let firstSettled = false
      const firstNext = gen.next().then((result) => {
        firstSettled = true
        return result
      })
      await Promise.resolve()
      expect(firstSettled).toBe(false)
      expect(mockBucket.copyFile).not.toHaveBeenCalled()

      releaseSecond()
      const compare = await firstNext
      expect(compare.value).toMatchObject({ type: 'compare', path: 'a.txt' })

      const upload = await gen.next()
      expect(upload.value).toMatchObject({ type: 'copy-done', path: 'a.txt' })
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)

      const rest: SyncEvent[] = []
      for await (const event of gen) rest.push(event)
      expect(rest.some((event) => event.type === 'copy-done' && event.path === 'b.txt')).toBe(true)
    })

    it('plans non-sha1 action batches by concurrency instead of total pairs', async () => {
      const previousHook = synchronizerTestHooks.afterNonSha1PlanBatch
      const batchSizes: number[] = []
      synchronizerTestHooks.afterNonSha1PlanBatch = (batchSize) => {
        batchSizes.push(batchSize)
      }
      try {
        const source = makeMemoryFolder(
          Array.from({ length: 5 }, (_, index) => makeB2SyncPath(`file-${index}.txt`, 1000, 1)),
          'b2',
        )
        const dest = makeMemoryFolder([], 'b2')
        const config = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            concurrency: 2,
            dryRun: true,
          },
          bucket: makeMockBucket() as unknown as Bucket,
        } satisfies SynchronizerConfig & { readonly bucket: Bucket }

        await collectEvents(config)

        expect(batchSizes).toEqual([2, 2, 1])
      } finally {
        if (previousHook === undefined) {
          delete synchronizerTestHooks.afterNonSha1PlanBatch
        } else {
          synchronizerTestHooks.afterNonSha1PlanBatch = previousHook
        }
      }
    })

    it('does not overlap sha1 compare hashing with in-flight transfers', async () => {
      const data = new Uint8Array([1, 2, 3])
      const sha1 = await sha1Hex(data)
      const source = makeMemoryFolder(
        [
          makeB2SyncPath('copy.txt', 1000, 10),
          makeB2SyncPath(
            'verify.txt',
            1000,
            data.byteLength,
            undefined,
            null,
            { large_file_sha1: sha1 },
            `unverified:${sha1}`,
          ),
        ],
        'b2',
      )
      const dest = makeMemoryFolder(
        [makeB2SyncPath('verify.txt', 1000, data.byteLength, undefined, sha1)],
        'b2',
      )
      const mockBucket = makeMockBucket({ 'fid_verify.txt': data })
      let finishCopy = () => {}
      const copyMayFinish = new Promise<void>((resolve) => {
        finishCopy = resolve
      })
      mockBucket.copyFile.mockImplementation(async () => {
        await copyMayFinish
      })
      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', concurrency: 1 },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const gen = synchronize(config)
      const compare = await gen.next()
      expect(compare.value).toMatchObject({ type: 'compare', path: 'copy.txt' })

      const copyEvent = gen.next()
      for (
        let attempts = 0;
        mockBucket.copyFile.mock.calls.length === 0 && attempts < 10;
        attempts++
      ) {
        await Promise.resolve()
      }
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)
      expect(mockBucket.downloadById).not.toHaveBeenCalled()

      finishCopy()
      await expect(copyEvent).resolves.toMatchObject({
        value: expect.objectContaining({ type: 'copy-done', path: 'copy.txt' }),
      })

      await gen.return(undefined)
    })

    it('applies sync include/exclude filters to both sides before comparing', async () => {
      const source = makeMemoryFolder(
        [
          makeLocalSyncPath('docs/keep.txt', 1000, 100),
          makeLocalSyncPath('docs/ignore.tmp', 1000, 100),
          makeLocalSyncPath('logs/ignored.txt', 1000, 100),
        ],
        'local',
      )
      const dest = makeMemoryFolder(
        [
          makeB2SyncPath('docs/keep.txt', 1000, 100),
          makeB2SyncPath('docs/remote.tmp', 1000, 100),
          makeB2SyncPath('logs/remote.txt', 1000, 100),
        ],
        'b2',
      )

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'delete',
          dryRun: true,
          include: ['docs/**'],
          exclude: ['*.tmp'],
        },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events.map((event) => event.path)).toEqual(['docs/keep.txt', 'docs/keep.txt'])
    })

    it('blocks excluded output from scanners that claim to apply filters', async () => {
      const excludedLocal = makeLocalSyncPath('.env', 1000, 6)
      const excludedB2 = makeB2SyncPath('.env', 1000, 6)
      const maliciousFolder = (paths: readonly SyncPath[], type: 'local' | 'b2'): SyncFolder => ({
        type,
        appliesScanFilters: true,
        appliesScanSorting: true,
        async *scan() {
          yield* paths
        },
      })
      const mockBucket = makeMockBucket()
      const commonOptions = {
        compareMode: 'modtime',
        keepMode: 'delete',
        dryRun: true,
        exclude: ['.env'],
      } as const

      const cases: SynchronizerConfig[] = [
        {
          source: {
            ...maliciousFolder([excludedLocal], 'local'),
            type: 'local',
            root: '/tmp',
          },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: commonOptions,
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        } as SynchronizerUpConfig,
        {
          source: { ...maliciousFolder([excludedB2], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root: '/tmp' },
          options: commonOptions,
          bucket: mockBucket as unknown as Bucket,
        } as SynchronizerDownConfig,
        {
          source: { ...maliciousFolder([excludedB2], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: commonOptions,
          bucket: mockBucket as unknown as Bucket,
        } as SynchronizerConfig & { readonly bucket: Bucket },
        {
          source: { ...makeMemoryFolder([], 'local'), type: 'local', root: '/tmp' },
          dest: { ...maliciousFolder([excludedB2], 'b2'), type: 'b2' },
          options: commonOptions,
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        } as SynchronizerUpConfig,
        {
          source: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          dest: {
            ...maliciousFolder([excludedLocal], 'local'),
            type: 'local',
            root: '/tmp',
          },
          options: commonOptions,
          bucket: mockBucket as unknown as Bucket,
        } as SynchronizerDownConfig,
      ]

      for (const config of cases) {
        const events = await collectEvents(config)
        expect(events.map((event) => event.type)).not.toContain('upload-done')
        expect(events.map((event) => event.type)).not.toContain('download-done')
        expect(events.map((event) => event.type)).not.toContain('copy-done')
        expect(events.map((event) => event.type)).not.toContain('delete-local')
        expect(events.map((event) => event.type)).not.toContain('delete-remote')
        expect(events.map((event) => event.type)).not.toContain('hide')
      }
    })

    it.skipIf(!isNode || isWindows || isDarwin)(
      'skips over-limit local paths for exclude-only RegExp filters during synchronize',
      async () => {
        const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-regexp-long-'))
        try {
          const deepSegments = Array.from({ length: 210 }, () => 'deep')
          const longDirectory = join(root, 'secrets', ...deepSegments)
          await mkdir(longDirectory, { recursive: true })
          await writeFile(join(longDirectory, 'token.txt'), 'secret')

          const mockBucket = makeMockBucket()
          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
            options: {
              compareMode: 'modtime',
              keepMode: 'no-delete',
              exclude: [/^secrets\//],
            },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({ type: 'skip', reason: 'path-too-long-for-regexp' }),
          )
          expect(events.some((event) => event.type === 'upload-done')).toBe(false)
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)(
      'does not delete remote descendants for exact slash-containing excludes',
      async () => {
        const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-filter-'))
        try {
          await mkdir(join(root, 'a', 'b'), { recursive: true })
          await writeFile(join(root, 'a', 'b', 'c.txt'), 'keep')

          const mockBucket = makeMockBucket()
          const destFile = makeB2SyncPath('a/b/c.txt', 1000, 4)
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...dest, type: 'b2' },
            options: {
              compareMode: 'size',
              keepMode: 'delete',
              exclude: ['a/b'],
            },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          expect(events.some((event) => event.type === 'delete-remote')).toBe(false)
          expect(events.map((event) => event.path)).toContain('a/b/c.txt')
          expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it('keeps local deletes blocked after skipped B2 source names', async () => {
      const fileVersion: FileVersion = {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'bucket' as unknown as BucketId,
        contentLength: 10,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: 'fid_unsafe' as unknown as FileId,
        fileInfo: {},
        fileName: 'docs/./readme.md',
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: 1000,
      }
      const bucket = {
        ...makeMockBucket(),
        listFileVersions: vi.fn().mockResolvedValue({
          files: [fileVersion],
          nextFileName: null,
          nextFileId: null,
        }),
      }
      const source = new B2Folder(bucket as unknown as Bucket)
      const dest = makeMemoryFolder([makeLocalSyncPath('docs/readme.md', 1000, 10)], 'local')

      const config: SynchronizerDownConfig = {
        source,
        dest: { ...dest, type: 'local', root: '/tmp' },
        options: {
          compareMode: 'modtime',
          keepMode: 'delete',
          dryRun: true,
        },
        bucket: bucket as unknown as Bucket,
      }

      const events = await collectEvents(config)

      expect(events[0]).toMatchObject({
        type: 'skip',
        path: 'docs/./readme.md',
        reason: 'unsafe-name',
        b2FileName: 'docs/./readme.md',
      })
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'skip',
          path: 'docs/readme.md',
          message: 'not removed because the source scan skipped unsafe B2 names',
        }),
      )
      expect(events.some((event) => event.type === 'delete-local')).toBe(false)
    })

    it.skipIf(!isNode || process.platform === 'win32')(
      'skips literal-backslash local filenames before upload pairing',
      async () => {
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-backslash-'))
        try {
          await writeFile(join(root, 'a\\b.txt'), 'backslash')
          const mockBucket = makeMockBucket()
          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
            options: {
              compareMode: 'modtime',
              keepMode: 'no-delete',
              include: ['a/b.txt'],
            },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({ type: 'skip', reason: 'unsafe-name', path: 'a\\b.txt' }),
          )
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it('does not delete local files when slashless B2 prefixes include slash-prefixed keys', async () => {
      const fileVersion: FileVersion = {
        accountId: 'acc' as unknown as AccountId,
        action: FileAction.Upload,
        bucketId: 'bucket' as unknown as BucketId,
        contentLength: 10,
        contentMd5: null,
        contentSha1: 'sha1',
        contentType: 'application/octet-stream',
        fileId: 'fid_readme' as unknown as FileId,
        fileInfo: {},
        fileName: 'backup/docs/readme.md',
        fileRetention: { isClientAuthorizedToRead: true, value: null },
        legalHold: { isClientAuthorizedToRead: true, value: null },
        replicationStatus: null,
        serverSideEncryption: { mode: EncryptionMode.None },
        uploadTimestamp: 1000,
      }
      const calls: Array<{ prefix?: string }> = []
      const bucket = {
        ...makeMockBucket(),
        listFileVersions: vi.fn().mockImplementation((opts?: { prefix?: string }) => {
          calls.push({
            ...(opts?.prefix !== undefined ? { prefix: opts.prefix } : {}),
          })
          return Promise.resolve({
            files: [fileVersion],
            nextFileName: null,
            nextFileId: null,
          })
        }),
      }
      const source = new B2Folder(bucket as unknown as Bucket, 'backup')
      const dest = makeMemoryFolder([makeLocalSyncPath('docs/readme.md', 1000, 10)], 'local')

      const config: SynchronizerDownConfig = {
        source,
        dest: { ...dest, type: 'local', root: '/tmp' },
        options: {
          compareMode: 'modtime',
          keepMode: 'delete',
          include: ['docs/**'],
          dryRun: true,
        },
        bucket: bucket as unknown as Bucket,
      }

      const events = await collectEvents(config)

      expect(calls).toEqual([{ prefix: 'backup' }])
      expect(events.some((event) => event.type === 'delete-local')).toBe(false)
      expect(events.map((event) => event.path)).toContain('docs/readme.md')
    })

    it('bounds buffered scanner skip diagnostics before the first scan result', async () => {
      function makeUnsafeFileVersion(index: number): FileVersion {
        return {
          accountId: 'acc' as unknown as AccountId,
          action: FileAction.Upload,
          bucketId: 'bucket' as unknown as BucketId,
          contentLength: 1,
          contentMd5: null,
          contentSha1: 'sha1',
          contentType: 'application/octet-stream',
          fileId: `fid_${index}` as unknown as FileId,
          fileInfo: {},
          fileName: `docs/./unsafe-${index}.txt`,
          fileRetention: { isClientAuthorizedToRead: true, value: null },
          legalHold: { isClientAuthorizedToRead: true, value: null },
          replicationStatus: null,
          serverSideEncryption: { mode: EncryptionMode.None },
          uploadTimestamp: index,
        }
      }

      const bucket = {
        ...makeMockBucket(),
        listFileVersions: vi.fn().mockResolvedValue({
          files: Array.from({ length: 105 }, (_, index) => makeUnsafeFileVersion(index)),
          nextFileName: null,
          nextFileId: null,
        }),
      }

      const config: SynchronizerDownConfig = {
        source: new B2Folder(bucket as unknown as Bucket),
        dest: { ...makeMemoryFolder([], 'local'), type: 'local', root: '/tmp' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
        bucket: bucket as unknown as Bucket,
      }

      const events = await collectEvents(config)
      const scannerSkips = events.filter((event) => event.type === 'skip')

      expect(scannerSkips).toHaveLength(101)
      expect(scannerSkips.at(-1)).toMatchObject({
        reason: 'scan-skip-overflow',
        message: '5 scanner skip event(s) were omitted after 100 buffered diagnostics',
      })
    })
  })

  describe('action execution (upload direction)', () => {
    it('skips upload when files match (same modtime and size)', async () => {
      const sourceFile = makeLocalSyncPath('same.txt', 1000, 100)
      const destFile = makeB2SyncPath('same.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skipEvents = events.filter((e) => e.type === 'skip')
      expect(skipEvents).toHaveLength(1)
      expect(skipEvents[0]?.message).toBe('files are the same')
    })

    it.skipIf(!isNode || isWindows)('rejects a scan-to-upload symlink swap', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, symlink, unlink, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { LocalFolder } = await import('./scanners/local.ts')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-race-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-race-out-'))
      try {
        const filePath = join(root, 'report.txt')
        const secretPath = join(outside, 'id_rsa')
        await writeFile(filePath, 'safe')
        await writeFile(secretPath, 'secret')
        const scanned: LocalSyncPath[] = []
        for await (const path of new LocalFolder(root).scan()) scanned.push(path)
        await unlink(filePath)
        await symlink(secretPath, filePath)

        const mockBucket = makeMockBucket()
        const config: SynchronizerUpConfig = {
          source: { ...makeMemoryFolder(scanned, 'local'), type: 'local', root },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }
        const events = await collectEvents(config)

        expect(mockBucket.upload).not.toHaveBeenCalled()
        const errors = events.filter((event) => event.type === 'error')
        expect(errors[0]?.message).toContain('Refusing to access path through symlink')
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('rejects upload when the scanned path is a directory', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-dir-'))
      try {
        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'dir',
          absolutePath: root,
          modTimeMillis: 1000,
          size: 0,
        }
        const config: SynchronizerUpConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'local'), type: 'local', root },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(mockBucket.upload).not.toHaveBeenCalled()
        expect(events.find((event) => event.type === 'error')?.message).toContain(
          'not a regular file',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('rejects upload when the scanned file size changes', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-size-'))
      try {
        const filePath = join(root, 'report.txt')
        await writeFile(filePath, 'safe')
        await writeFile(filePath, 'changed')
        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'report.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: 4,
        }
        const config: SynchronizerUpConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'local'), type: 'local', root },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(mockBucket.upload).not.toHaveBeenCalled()
        expect(events.find((event) => event.type === 'error')?.message).toContain('size changed')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('rejects upload when same-size file identity changes', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { LocalFolder } = await import('./scanners/local.ts')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-identity-'))
      try {
        const filePath = join(root, 'report.txt')
        await writeFile(filePath, 'safe')
        const scanned: LocalSyncPath[] = []
        for await (const path of new LocalFolder(root).scan()) scanned.push(path)
        const [path] = scanned
        if (path?.fileIdentity === undefined) throw new Error('expected scanned file identity')
        const staleIdentity = {
          ...path.fileIdentity,
          inode: path.fileIdentity.inode + 1,
        }
        const stalePath: LocalSyncPath = { ...path, fileIdentity: staleIdentity }

        const mockBucket = makeMockBucket()
        const config: SynchronizerUpConfig = {
          source: {
            ...makeMemoryFolder([stalePath], 'local'),
            type: 'local',
            root,
          },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(mockBucket.upload).not.toHaveBeenCalled()
        expect(events.find((event) => event.type === 'error')?.message).toContain(
          'local file changed before upload',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('yields action outcomes as each action settles', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-stream-actions-'))
      try {
        const slow = deferred()
        const slowPath = join(root, 'a-slow.txt')
        const fastPath = join(root, 'b-fast.txt')
        await writeFile(slowPath, 'slow')
        await writeFile(fastPath, 'fast')

        const mockBucket = makeMockBucket()
        mockBucket.upload = vi
          .fn()
          .mockImplementation((options: { readonly fileName: string }) =>
            options.fileName === 'a-slow.txt' ? slow.promise : Promise.resolve(undefined),
          )

        const sourceFiles: LocalSyncPath[] = [
          {
            relativePath: 'a-slow.txt',
            absolutePath: slowPath,
            modTimeMillis: 2000,
            size: 4,
          },
          {
            relativePath: 'b-fast.txt',
            absolutePath: fastPath,
            modTimeMillis: 2000,
            size: 4,
          },
        ]
        const source = makeMemoryFolder(sourceFiles, 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 2 },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const gen = synchronize(config)
        await expect(gen.next()).resolves.toMatchObject({
          done: false,
          value: { type: 'compare', path: 'a-slow.txt' },
        })
        await expect(gen.next()).resolves.toMatchObject({
          done: false,
          value: { type: 'compare', path: 'b-fast.txt' },
        })
        await expect(gen.next()).resolves.toMatchObject({
          done: false,
          value: { type: 'upload-done', path: 'b-fast.txt' },
        })

        let slowResolved = false
        const slowEvent = gen.next().then((next) => {
          slowResolved = true
          return next
        })
        await new Promise((resolve) => setTimeout(resolve, 5))
        expect(slowResolved).toBe(false)

        slow.resolve(undefined)
        await expect(slowEvent).resolves.toMatchObject({
          done: false,
          value: { type: 'upload-done', path: 'a-slow.txt' },
        })
        await expect(gen.next()).resolves.toMatchObject({ done: true })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'aborts and awaits in-flight actions when the iterator closes early',
      async () => {
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-close-actions-'))
        try {
          const slowPath = join(root, 'a-slow.txt')
          const fastPath = join(root, 'b-fast.txt')
          await writeFile(slowPath, 'slow')
          await writeFile(fastPath, 'fast')

          const slowStarted = deferred()
          const slowAborted = deferred()
          const mockBucket = makeMockBucket()
          mockBucket.upload = vi
            .fn()
            .mockImplementation(
              (options: { readonly fileName: string; readonly signal?: AbortSignal }) => {
                if (options.fileName !== 'a-slow.txt') return Promise.resolve(undefined)
                slowStarted.resolve(undefined)
                return new Promise<void>((resolve) => {
                  if (options.signal?.aborted === true) {
                    slowAborted.resolve(undefined)
                    resolve()
                    return
                  }
                  options.signal?.addEventListener(
                    'abort',
                    () => {
                      slowAborted.resolve(undefined)
                      resolve()
                    },
                    { once: true },
                  )
                })
              },
            )

          const sourceFiles: LocalSyncPath[] = [
            { relativePath: 'a-slow.txt', absolutePath: slowPath, modTimeMillis: 2000, size: 4 },
            { relativePath: 'b-fast.txt', absolutePath: fastPath, modTimeMillis: 2000, size: 4 },
          ]
          const source = makeMemoryFolder(sourceFiles, 'local')
          const dest = makeMemoryFolder([], 'b2')
          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 2 },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const gen = synchronize(config)
          await expect(gen.next()).resolves.toMatchObject({
            done: false,
            value: { type: 'compare', path: 'a-slow.txt' },
          })
          await expect(gen.next()).resolves.toMatchObject({
            done: false,
            value: { type: 'compare', path: 'b-fast.txt' },
          })
          await expect(gen.next()).resolves.toMatchObject({
            done: false,
            value: { type: 'upload-done', path: 'b-fast.txt' },
          })

          await slowStarted.promise
          await expect(gen.return(undefined)).resolves.toMatchObject({ done: true })
          await expect(slowAborted.promise).resolves.toBeUndefined()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('passes abort signals to upload transfers', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-upload-signal-'))
      try {
        const controller = new AbortController()
        const filePath = join(root, 'signal.txt')
        await writeFile(filePath, 'signal')
        const mockBucket = makeMockBucket()
        const uploadStarted = deferred<{
          readonly fileName: string
          readonly signal?: AbortSignal
        }>()
        const releaseUpload = deferred()
        mockBucket.upload = vi
          .fn()
          .mockImplementation(
            async (options: { readonly fileName: string; readonly signal?: AbortSignal }) => {
              uploadStarted.resolve(options)
              await releaseUpload.promise
            },
          )
        const sourceFiles: LocalSyncPath[] = [
          {
            relativePath: 'signal.txt',
            absolutePath: filePath,
            modTimeMillis: 2000,
            size: 6,
          },
        ]
        const source = makeMemoryFolder(sourceFiles, 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            signal: controller.signal,
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const eventsPromise = collectEvents(config)
        const uploadOptions = await uploadStarted.promise

        expect(uploadOptions.fileName).toBe('signal.txt')
        expect(uploadOptions.signal).toBeInstanceOf(AbortSignal)
        expect(uploadOptions.signal?.aborted).toBe(false)
        controller.abort(new Error('stop upload'))
        expect(uploadOptions.signal?.aborted).toBe(true)
        releaseUpload.resolve(undefined)
        await eventsPromise
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('refuses uploads when a scanned file is swapped to a symlink', async () => {
      const { lstat, mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-upload-symlink-'))
      const root = join(parent, 'root')
      const outside = join(parent, 'outside')
      const sourcePath = join(root, 'public.txt')
      const secretPath = join(outside, 'secret.txt')
      try {
        const { mkdir } = await import('node:fs/promises')
        await mkdir(root)
        await mkdir(outside)
        await writeFile(sourcePath, 'public')
        await writeFile(secretPath, 'secret')
        const sourceStats = await lstat(sourcePath)

        const sourceFile: LocalSyncPath = {
          relativePath: 'public.txt',
          absolutePath: sourcePath,
          modTimeMillis: Math.floor(sourceStats.mtimeMs),
          size: sourceStats.size,
          fileIdentity: {
            deviceId: sourceStats.dev,
            inode: sourceStats.ino,
            size: sourceStats.size,
            modTimeMillis: Math.floor(sourceStats.mtimeMs),
          },
        }
        await rm(sourcePath, { force: true })
        await symlink(secretPath, sourcePath, 'file')

        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')
        const mockBucket = makeMockBucket()
        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({ type: 'error', path: 'public.txt' }),
        )
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { readonly code?: unknown }).code
            : undefined
        if (code !== 'EPERM' && code !== 'EACCES') throw error
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('uses a slashless B2 upload prefix as a raw key prefix', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-raw-prefix-'))
      try {
        const filePath = join(root, 'file.txt')
        await writeFile(filePath, 'raw-prefix')
        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'file.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 10,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'backups',
        }

        await collectEvents(config)

        expect(mockBucket.upload).toHaveBeenCalledWith(
          expect.objectContaining({ fileName: 'backupsfile.txt' }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe('dry-run mode', () => {
    it('produces events without performing actual uploads', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeLocalSyncPath('dry.txt', 2000, 150)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // Should still emit the compare event and the upload-done event (dry run still returns events)
      const uploadEvents = events.filter((e) => e.type === 'upload-done')
      expect(uploadEvents).toHaveLength(1)
      // But the bucket's upload method should NOT have been called
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })

    it('produces skip events without side effects in dry-run', async () => {
      const mockBucket = makeMockBucket()
      const destFile = makeB2SyncPath('orphan.txt', 1000, 100)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // With delete mode, dest-only files get a single removeOrphan
      // action (which picks hide vs deleteRemote based on the bucket's
      // file-lock state — vanilla here, so deleteRemote). In dry-run,
      // the bucket methods should not actually fire.
      expect(mockBucket.hideFile).not.toHaveBeenCalled()
      expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
      // Per file we now expect exactly one non-compare event.
      const nonCompare = events.filter((e) => e.type !== 'compare')
      expect(nonCompare.length).toBeGreaterThanOrEqual(1)
    })

    it.skipIf(!isNode)(
      'does not upload SDK partial-looking source files during dry-run',
      async () => {
        const { access, mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dry-partial-'))
        const partialPath = join(root, '.b2sdk-payroll.partial')
        try {
          await writeFile(partialPath, 'not a temp file')
          const mockBucket = makeMockBucket()
          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
            options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)

          expect(events).not.toContainEqual(
            expect.objectContaining({ type: 'upload-done', path: '.b2sdk-payroll.partial' }),
          )
          await expect(access(partialPath)).resolves.toBeFalsy()
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  describe('delete and keep policies', () => {
    it('skips dest-only files with no-delete keep mode', async () => {
      const destFile = makeB2SyncPath('orphan.txt', 1000, 50)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skipEvents = events.filter((e) => e.type === 'skip')
      expect(skipEvents).toHaveLength(1)
    })

    it('deletes dest-only files with delete keep mode', async () => {
      const mockBucket = makeMockBucket()
      const destFile = makeB2SyncPath('gone.txt', 1000, 50)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // For a vanilla bucket (no file-lock), `removeOrphan` routes to
      // `deleteRemote` only — no spurious hide marker.
      const hideEvents = events.filter((e) => e.type === 'hide')
      const deleteEvents = events.filter((e) => e.type === 'delete-remote')
      expect(hideEvents).toHaveLength(0)
      expect(deleteEvents).toHaveLength(1)
    })

    it.skipIf(!isNode)('does not delete remote orphans when local source scan fails', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { LocalFolder } = await import('./scanners/local.ts')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-scan-error-'))
      const missingRoot = join(root, 'missing-source')
      try {
        const mockBucket = makeMockBucket()
        const destFile = makeB2SyncPath('orphan.txt', 1000, 50)
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: new LocalFolder(missingRoot),
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const errors = events.filter((e) => e.type === 'error')
        expect(errors[0]?.message).toContain('failed to scan local directory')
        expect(mockBucket.hideFile).not.toHaveBeenCalled()
        expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)(
      'does not upload readable files after a local scan error',
      async () => {
        const { chmod, mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-scan-continue-'))
        const blockedDir = join(root, 'blocked')
        try {
          await mkdir(blockedDir)
          await chmod(blockedDir, 0)
          await writeFile(join(root, 'readable.txt'), 'ok')
          const mockBucket = makeMockBucket()

          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          const errors = events.filter((event) => event.type === 'error')
          expect(errors[0]?.message).toContain('failed to scan local directory')
          expect(events.filter((event) => event.type === 'upload-done')).toHaveLength(0)
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await chmod(blockedDir, 0o700).catch(() => {})
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode || isWindows)(
      'skips local symlinks without suppressing delete-mode orphan removal',
      async () => {
        const { mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-scan-symlink-'))
        try {
          await writeFile(join(root, 'target.txt'), 'target')
          await symlink(join(root, 'target.txt'), join(root, 'linked.txt'))
          const mockBucket = makeMockBucket()
          const destFile = makeB2SyncPath('linked.txt', 1000, 6)

          const config: SynchronizerUpConfig = {
            source: new LocalFolder(root),
            dest: { ...makeMemoryFolder([destFile], 'b2'), type: 'b2' },
            options: { compareMode: 'sha1', keepMode: 'delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          const errors = events.filter((event) => event.type === 'error')
          expect(errors).toHaveLength(0)
          expect(mockBucket.hideFile).not.toHaveBeenCalled()
          expect(mockBucket.deleteFileVersion).toHaveBeenCalledWith(
            'linked.txt',
            'fid_linked.txt',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          )
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it('does not start actions when a sorted scanner fails after yielding a file', async () => {
      const sourceFile = makeLocalSyncPath('uploaded.txt', 2000, 50)
      const mockBucket = makeMockBucket()
      const source: SyncFolder = {
        type: 'local',
        appliesScanSorting: true,
        async *scan(options: SyncScanOptions = {}) {
          yield sourceFile
          const event: SyncEvent = {
            type: 'error',
            path: 'later.txt',
            size: 0,
            message: 'failed to scan local file: EIO',
          }
          options.onError?.(event)
          throw new Error(event.message)
        },
      }
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'compare')).toBe(false)
      expect(events.some((event) => event.type === 'upload-done')).toBe(false)
      expect(mockBucket.upload).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', path: 'later.txt' }))
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          path: '',
          failureCount: 1,
          failedPaths: ['later.txt'],
        }),
      )
    })

    it('rethrows scan errors without diagnostics before starting actions', async () => {
      const sourceFile = makeB2SyncPath('copied.txt', 2000, 50)
      const source: SyncFolder = {
        type: 'b2',
        appliesScanSorting: true,
        async *scan() {
          yield sourceFile
          throw new Error('scan exploded')
        },
      }
      const dest = makeMemoryFolder([], 'b2')
      const mockBucket = makeMockBucket()
      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 4 },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      await expect(collectEvents(config)).rejects.toThrow('scan exploded')
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)('reports local deletes configured without a local root', async () => {
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([makeLocalSyncPath('orphan.txt', 1000, 10)], 'local')
      const mockBucket = makeMockBucket()

      const config: SynchronizerDownConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'local', root: '' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        bucket: mockBucket as unknown as Bucket,
      }

      const events = await collectEvents(config)

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          path: 'orphan.txt',
          message: 'Local sync root required for filesystem mutation',
        }),
      )
    })

    it.skipIf(!isNode)('refuses local deletes through a symlinked local root', async () => {
      const { mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-delete-root-symlink-'))
      const root = join(parent, 'root-link')
      const outside = join(parent, 'outside')
      try {
        await mkdir(outside)
        try {
          await symlink(outside, root, 'dir')
        } catch {
          return
        }

        const source = makeMemoryFolder([], 'b2')
        const dest = makeMemoryFolder([makeLocalSyncPath('orphan.txt', 1000, 10)], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'orphan.txt',
            message: 'Refusing to access sync root through symlink: orphan.txt',
          }),
        )
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it('keeps recent files with keep-days mode', async () => {
      const now = Date.now()
      const recentTime = now - 6 * 60 * 60 * 1000 // 6 hours ago (within 7 day retention)
      const destFile = makeB2SyncPath('recent.txt', recentTime, 50)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'keep-days', keepDays: 7 },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skipEvents = events.filter((e) => e.type === 'skip')
      expect(skipEvents).toHaveLength(1)
      expect(skipEvents[0]?.message).toContain('keeping for')
    })
  })

  describe('abort signal', () => {
    it('stops scanning when signal is aborted', async () => {
      const controller = new AbortController()
      // Abort immediately
      controller.abort()

      const sourceFile = makeLocalSyncPath('a.txt', 2000, 100)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          signal: controller.signal,
        },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // With signal already aborted, the generator returns early.
      // It may yield zero events or stop after the first iteration check.
      expect(events.length).toBeLessThanOrEqual(1)
    })

    it('closes active scan iterators when aborting during pairing', async () => {
      const controller = new AbortController()
      const cleanedUp: string[] = []
      const makeTrackedFolder = (name: string, type: 'local' | 'b2'): SyncFolder => ({
        type,
        async *scan() {
          try {
            yield { relativePath: 'a.txt', modTimeMillis: 1000, size: 10 }
            yield { relativePath: 'b.txt', modTimeMillis: 1000, size: 10 }
          } finally {
            cleanedUp.push(name)
          }
        },
      })
      const source = makeTrackedFolder('source', 'local')
      const dest = makeTrackedFolder('dest', 'b2')
      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'none',
          keepMode: 'no-delete',
          dryRun: true,
          signal: controller.signal,
        },
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      for await (const _event of synchronize(config)) {
        controller.abort()
      }

      expect(cleanedUp.sort()).toEqual(['dest', 'source'])
    })
  })

  describe('download direction actions', () => {
    // Skipped in browsers: the download action writes to local disk via
    // `node:fs/promises`, which is unavailable in non-Node runtimes.
    it.skipIf(!isNode)('executes download for source-only B2 file', async () => {
      // Use a portable per-OS tmpdir so this test passes on Windows (where
      // `/tmp/dest` would resolve to `C:\tmp\dest` and likely fail to create).
      const { tmpdir } = await import('node:os')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-'))
      try {
        const data = new Uint8Array([4, 5, 6])
        const mockBucket = makeMockBucket({ 'fid_remote.txt': data })
        const sourceFile = makeB2SyncPath('remote.txt', 2000, data.byteLength)
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        const downloadEvents = events.filter((e) => e.type === 'download-done')
        expect(downloadEvents).toHaveLength(1)
        expect(downloadEvents[0]?.path).toBe('remote.txt')
        expect(mockBucket.file).toHaveBeenCalledWith('remote.txt')
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_remote.txt',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        await expect(readFile(join(root, 'remote.txt'))).resolves.toEqual(Buffer.from(data))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('passes abort signals to B2 download actions', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-abort-signal-'))
      try {
        const controller = new AbortController()
        const data = new Uint8Array([4, 5, 6])
        const mockBucket = makeMockBucket({ 'fid_remote.txt': data })
        mockBucket.downloadById.mockImplementation(
          (_fileId: string, callOptions?: { readonly signal?: AbortSignal }) => {
            expect(callOptions?.signal).toEqual(expect.any(AbortSignal))
            expect(callOptions?.signal).not.toBe(controller.signal)
            expect(callOptions?.signal?.aborted).toBe(false)
            controller.abort()
            expect(callOptions?.signal?.aborted).toBe(true)
            return { body: streamFromBytes(data) }
          },
        )
        const sourceFile = makeB2SyncPath('remote.txt', 2000, data.byteLength)
        const config: SynchronizerDownConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            signal: controller.signal,
          },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        expect(events.some((event) => event.type === 'download-done')).toBe(false)
        expect(events.some((event) => event.type === 'error')).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('skips B2 names that are unsafe for local filesystem destinations', async () => {
      function makeFileVersion(fileName: string, uploadTimestamp: number): FileVersion {
        return {
          accountId: 'acc' as unknown as AccountId,
          action: FileAction.Upload,
          bucketId: 'bucket' as unknown as BucketId,
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
        ...makeMockBucket(),
        listFileVersions: vi.fn().mockResolvedValue({
          files: [
            makeFileVersion('safe.txt', 1),
            makeFileVersion('name:stream', 2),
            makeFileVersion('CON', 3),
            makeFileVersion('CONOUT$', 4),
            makeFileVersion('COM0.txt', 5),
            makeFileVersion('nul.tar.gz', 6),
            makeFileVersion('dir/C:/x', 7),
            makeFileVersion('trailing.', 8),
            makeFileVersion('Readme.txt', 9),
            makeFileVersion('README.txt', 10),
          ],
          nextFileName: null,
          nextFileId: null,
        }),
      }

      const source = new B2Folder(mockBucket as unknown as Bucket)
      const dest = makeMemoryFolder([], 'local')
      const config: SynchronizerDownConfig = {
        source,
        dest: { ...dest, type: 'local', root: '/tmp' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
      }

      const events = await collectEvents(config)

      expect(events).toContainEqual(expect.objectContaining({ type: 'compare', path: 'safe.txt' }))
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'local-unsafe-name', path: 'CON' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'local-unsafe-name', path: 'CONOUT$' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'local-unsafe-name', path: 'COM0.txt' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'local-unsafe-name', path: 'nul.tar.gz' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'local-unsafe-name', path: 'dir/C:/x' }),
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'skip',
          reason: 'local-path-collision',
          path: 'Readme.txt',
        }),
      )
      expect(mockBucket.download).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)('fails a stalled download body after the idle timeout', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-stall-'))
      try {
        const sourceFile = makeB2SyncPath('stalled.txt', 2000, 200)
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()
        mockBucket.downloadById.mockReturnValue({
          body: new ReadableStream<Uint8Array>({
            start() {
              // Leave the stream open without producing bytes.
            },
          }),
        })

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            downloadIdleTimeoutMillis: 5,
          },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'stalled.txt',
            message: 'download read stalled for 5 ms',
          }),
        )
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: '',
            message: '1 sync error(s) occurred',
          }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('reports invalid download idle timeout values', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-timeout-'))
      try {
        const source = makeMemoryFolder([makeB2SyncPath('payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            downloadIdleTimeoutMillis: 0,
          },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'payload.txt',
            message: 'downloadIdleTimeoutMillis must be a positive finite number or Infinity',
          }),
        )
        expect(mockBucket.downloadById).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('allows downloads with the idle timeout disabled', async () => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-no-timeout-'))
      try {
        const source = makeMemoryFolder([makeB2SyncPath('payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            downloadIdleTimeoutMillis: Number.POSITIVE_INFINITY,
          },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(false)
        await expect(
          readFile(join(root, 'payload.txt')).then((data) => Array.from(data)),
        ).resolves.toEqual([1, 2, 3])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('reports aborts while waiting for download body data', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-abort-wait-'))
      try {
        const controller = new AbortController()
        const source = makeMemoryFolder([makeB2SyncPath('payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()
        mockBucket.downloadById.mockReturnValue({
          body: new ReadableStream<Uint8Array>({
            start() {
              setTimeout(() => controller.abort(new Error('download cancelled')), 0)
            },
          }),
        })

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            downloadIdleTimeoutMillis: Number.POSITIVE_INFINITY,
            signal: controller.signal,
          },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'payload.txt',
            message: 'download cancelled',
          }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'does not sweep active partial files from concurrent downloads',
      async () => {
        const { mkdtemp, readFile, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-concurrent-'))
        const slowClose = deferred()
        try {
          const slowReadStarted = deferred()
          let slowPulled = false
          const mockBucket = makeMockBucket()
          mockBucket.downloadById.mockImplementation(async (fileId: string) => {
            if (fileId === 'fid_same/a-slow.txt') {
              return {
                body: new ReadableStream<Uint8Array>({
                  pull(controller) {
                    if (!slowPulled) {
                      slowPulled = true
                      slowReadStarted.resolve(undefined)
                      controller.enqueue(new Uint8Array([1]))
                      return slowClose.promise
                    }
                    controller.close()
                    return undefined
                  },
                }),
              }
            }

            await slowReadStarted.promise
            setTimeout(() => slowClose.resolve(undefined), 10)
            return {
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([2]))
                  controller.close()
                },
              }),
            }
          })
          const source = makeMemoryFolder(
            [
              makeB2SyncPath('same/a-slow.txt', 2000, 1),
              makeB2SyncPath('same/b-fast.txt', 2000, 1),
            ],
            'b2',
          )
          const dest = makeMemoryFolder([], 'local')

          const config: SynchronizerDownConfig = {
            source: { ...source, type: 'b2' },
            dest: { ...dest, type: 'local', root },
            options: {
              compareMode: 'modtime',
              keepMode: 'no-delete',
              concurrency: 2,
            },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events.filter((event) => event.type === 'error')).toEqual([])
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'download-done', path: 'same/a-slow.txt' }),
          )
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'download-done', path: 'same/b-fast.txt' }),
          )
          await expect(readFile(join(root, 'same', 'a-slow.txt'))).resolves.toEqual(
            Buffer.from([1]),
          )
          await expect(readFile(join(root, 'same', 'b-fast.txt'))).resolves.toEqual(
            Buffer.from([2]),
          )
        } finally {
          slowClose.resolve(undefined)
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('refuses downloads outside the local sync root', async () => {
      const { access, mkdtemp, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { basename, dirname, join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-down-root-'))
      const outsidePath = join(dirname(root), `${basename(root)}-escape.txt`)
      try {
        const source = makeMemoryFolder([makeB2SyncPath('../escape.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: '../escape.txt',
          }),
        )
        await expect(access(outsidePath)).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outsidePath, { force: true })
      }
    })

    it.skipIf(!isNode)(
      'rejects over-length B2 download bodies without writing final files',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, readFile, rm } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-overlong-'))
        try {
          const mockBucket = makeMockBucket({ 'fid_remote.txt': new Uint8Array([1, 2]) })
          const sourceFile = makeB2SyncPath('remote.txt', 2000, 1)
          const config: SynchronizerDownConfig = {
            source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
            dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)
          const errors = events.filter((event) => event.type === 'error')
          expect(events.some((event) => event.type === 'download-done')).toBe(false)
          expect(errors[0]?.message).toContain('download read exceeded 1 byte limit')
          await expect(readFile(join(root, 'remote.txt'))).rejects.toThrow()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('writes multi-chunk B2 download bodies in order', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-chunks-'))
      try {
        const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]
        const mockBucket = makeMockBucket()
        mockBucket.downloadById.mockReturnValue({ body: streamFromChunks(chunks) })
        const sourceFile = makeB2SyncPath('remote.txt', 2000, 5)

        const config: SynchronizerDownConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        expect(events.some((event) => event.type === 'download-done')).toBe(true)
        await expect(readFile(join(root, 'remote.txt'))).resolves.toEqual(
          Buffer.from([1, 2, 3, 4, 5]),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)('rejects B2 names that escape the local root', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { basename, join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-traversal-'))
      const outsidePath = join(root, '..', `${basename(root)}-outside.txt`)
      try {
        await rm(outsidePath, { force: true })
        const mockBucket = makeMockBucket({ 'fid_../outside.txt': new Uint8Array([1]) })
        const sourceFile = makeB2SyncPath(`../${basename(outsidePath)}`, 2000, 1)
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }
        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(true)
        await expect(rm(outsidePath, { force: false })).rejects.toThrow()
      } finally {
        await rm(outsidePath, { force: true })
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('allows safe path segments that start with dots', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-dot-prefix-'))
      try {
        const data = new Uint8Array([8, 9])
        const mockBucket = makeMockBucket({ 'fid_..evil/payload.txt': data })
        const sourceFile = makeB2SyncPath('..evil/payload.txt', 2000, data.byteLength)

        const config: SynchronizerDownConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }
        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'download-done')).toBe(true)
        await expect(readFile(join(root, '..evil', 'payload.txt'))).resolves.toEqual(
          Buffer.from(data),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)('rejects absolute B2 names for local downloads', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-absolute-'))
      try {
        const mockBucket = makeMockBucket()
        const sourceFile = makeB2SyncPath('/absolute.txt', 2000, 1)
        const config: SynchronizerDownConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }
        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(true)
        expect(mockBucket.downloadById).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('allows downloads inside dot-prefixed local directories', async () => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dot-prefix-'))
      try {
        const source = makeMemoryFolder(
          [makeB2SyncPath('.dots/file.txt', 1000, 3), makeB2SyncPath('..foo/file.txt', 1000, 3)],
          'b2',
        )
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(false)
        await expect(
          readFile(join(root, '.dots', 'file.txt')).then((data) => Array.from(data)),
        ).resolves.toEqual([1, 2, 3])
        await expect(
          readFile(join(root, '..foo', 'file.txt')).then((data) => Array.from(data)),
        ).resolves.toEqual([1, 2, 3])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('creates the local sync root before download descendants', async () => {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-missing-root-'))
      const root = join(parent, 'missing-root')
      try {
        const source = makeMemoryFolder([makeB2SyncPath('docs/payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(false)
        await expect(
          readFile(join(root, 'docs', 'payload.txt')).then((data) => Array.from(data)),
        ).resolves.toEqual([1, 2, 3])
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)('rejects symlinked local parents on download', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-symlink-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-symlink-out-'))
      try {
        await mkdir(join(root, 'safe'), { recursive: true })
        await symlink(outside, join(root, 'safe', 'link'), 'dir')
        const mockBucket = makeMockBucket({ 'fid_safe/link/payload.txt': new Uint8Array([7]) })
        const sourceFile = makeB2SyncPath('safe/link/payload.txt', 2000, 1)

        const config: SynchronizerDownConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
          dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }
        const events = await collectEvents(config)

        expect(events.some((event) => event.type === 'error')).toBe(true)
        await expect(rm(join(outside, 'payload.txt'), { force: false })).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)(
      'cancels an acquired download body when destination setup fails',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-cancel-root-'))
        const outside = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-cancel-out-'))
        try {
          await mkdir(join(root, 'docs'), { recursive: true })
          await rm(join(root, 'docs'), { recursive: true, force: true })
          await symlink(outside, join(root, 'docs'), 'dir')
          let canceled = false
          const body = new ReadableStream<Uint8Array>({
            cancel() {
              canceled = true
            },
          })
          const mockBucket = makeMockBucket()
          mockBucket.downloadById.mockReturnValue({ body })
          const sourceFile = makeB2SyncPath('docs/payload.txt', 2000, 1)

          const config: SynchronizerDownConfig = {
            source: { ...makeMemoryFolder([sourceFile], 'b2'), type: 'b2' },
            dest: { ...makeMemoryFolder([], 'local'), type: 'local', root },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({ type: 'error', path: 'docs/payload.txt' }),
          )
          expect(canceled).toBe(true)
        } finally {
          await rm(root, { recursive: true, force: true })
          await rm(outside, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode || isWindows)(
      'rejects local parent symlink swaps before opening download targets',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } = await import(
          'node:fs/promises'
        )
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-swap-root-'))
        const outside = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-swap-out-'))
        try {
          const safeDir = join(root, 'safe')
          await mkdir(safeDir)
          const safeDirReal = await realpath(safeDir)
          let swapped = false
          localFileIoTestHooks.afterParentDirectoryValidated = async (validatedPath) => {
            if (validatedPath !== safeDirReal || swapped) return
            swapped = true
            await rename(safeDir, join(root, 'safe-real'))
            await symlink(outside, safeDir, 'dir')
          }

          await expect(
            writeLocalStreamInsideRoot(
              root,
              'safe/payload.txt',
              streamFromBytes(new Uint8Array([7])),
              {
                expectedBytes: 1,
                idleTimeoutMillis: 1000,
              },
            ),
          ).rejects.toThrow(/unsafe local destination path/)
          await expect(readFile(join(outside, 'payload.txt'))).rejects.toThrow()
        } finally {
          delete localFileIoTestHooks.afterParentDirectoryValidated
          await rm(root, { recursive: true, force: true })
          await rm(outside, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('refuses downloads through symlinked local directories', async () => {
      const { access, mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-symlink-'))
      const root = join(parent, 'root')
      const outside = join(parent, 'outside')
      const outsideFile = join(outside, 'payload.txt')
      try {
        await mkdir(root)
        await mkdir(outside)
        try {
          await symlink(outside, join(root, 'docs'), 'dir')
        } catch {
          return
        }

        const source = makeMemoryFolder([makeB2SyncPath('docs/payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'docs/payload.txt',
          }),
        )
        await expect(access(outsideFile)).rejects.toThrow()
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('refuses downloads through a symlinked local root', async () => {
      const { access, mkdir, mkdtemp, rm, symlink } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-root-symlink-'))
      const root = join(parent, 'root-link')
      const outside = join(parent, 'outside')
      const outsideFile = join(outside, 'payload.txt')
      try {
        await mkdir(outside)
        try {
          await symlink(outside, root, 'dir')
        } catch {
          return
        }

        const source = makeMemoryFolder([makeB2SyncPath('payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'payload.txt',
            message: 'Refusing to access sync root through symlink: payload.txt',
          }),
        )
        await expect(access(outsideFile)).rejects.toThrow()
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('refuses downloads when the local root is a file', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await mkdtemp(join(tmpdir(), 'b2sdk-sync-root-file-'))
      const root = join(parent, 'root-file')
      try {
        await writeFile(root, 'not a directory')

        const source = makeMemoryFolder([makeB2SyncPath('payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'payload.txt',
            message: 'Local sync root is not a directory: payload.txt',
          }),
        )
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('does not modify a swapped leaf symlink target', async () => {
      const fsPromises = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const parent = await fsPromises.mkdtemp(join(tmpdir(), 'b2sdk-sync-leaf-symlink-'))
      const root = join(parent, 'root')
      const outside = join(parent, 'outside')
      const outsideFile = join(outside, 'payload.txt')
      const destPath = join(root, 'docs', 'payload.txt')
      let stopRacing = false
      let racePromise: Promise<void> | undefined
      const startRacing = () => {
        racePromise ??= (async () => {
          while (!stopRacing) {
            await fsPromises.rm(destPath, { force: true })
            try {
              await fsPromises.symlink(outsideFile, destPath, 'file')
            } catch (error) {
              const code =
                typeof error === 'object' && error !== null && 'code' in error
                  ? (error as { readonly code?: unknown }).code
                  : undefined
              if (code === 'EPERM' || code === 'EACCES') return
            }
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        })()
      }
      try {
        await fsPromises.mkdir(root)
        await fsPromises.mkdir(outside)
        await fsPromises.writeFile(outsideFile, 'outside')

        const source = makeMemoryFolder([makeB2SyncPath('docs/payload.txt', 1000, 3)], 'b2')
        const dest = makeMemoryFolder([], 'local')
        const mockBucket = makeMockBucket()
        mockBucket.downloadById.mockReturnValue({
          body: new ReadableStream({
            async pull(controller) {
              startRacing()
              controller.enqueue(new Uint8Array([1, 2, 3]))
              controller.close()
            },
          }),
        })

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        await collectEvents(config)

        stopRacing = true
        await racePromise
        await expect(fsPromises.readFile(outsideFile, 'utf8')).resolves.toBe('outside')
      } finally {
        stopRacing = true
        await racePromise?.catch(() => undefined)
        await fsPromises.rm(parent, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'allows downloads when the local root already ends in a separator',
      async () => {
        const { mkdtemp, readFile, realpath, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join, parse, relative } = await import('node:path')
        const tempRoot = await mkdtemp(join(tmpdir(), 'b2sdk-sync-root-sep-'))
        const realTempRoot = await realpath(tempRoot)
        const targetPath = join(realTempRoot, 'download.txt')
        const parsed = parse(targetPath)
        const separator = parsed.root.includes('\\') ? '\\' : '/'
        const relativePath = relative(parsed.root, targetPath).split(separator).join('/')
        try {
          const source = makeMemoryFolder([makeB2SyncPath(relativePath, 1000, 3)], 'b2')
          const dest = makeMemoryFolder([], 'local')
          const mockBucket = makeMockBucket()

          const config: SynchronizerDownConfig = {
            source: { ...source, type: 'b2' },
            dest: { ...dest, type: 'local', root: parsed.root },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events.some((event) => event.type === 'error')).toBe(false)
          await expect(readFile(targetPath).then((data) => Array.from(data))).resolves.toEqual([
            1, 2, 3,
          ])
        } finally {
          await rm(tempRoot, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)(
      'cleans up partial download files when the source stream fails',
      async () => {
        const { mkdtemp, readdir, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-stream-fail-'))
        try {
          const source = makeMemoryFolder([makeB2SyncPath('broken.txt', 1000, 3)], 'b2')
          const dest = makeMemoryFolder([], 'local')
          const mockBucket = makeMockBucket()
          mockBucket.downloadById.mockReturnValue({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]))
                controller.error(new Error('stream failed'))
              },
            }),
          })

          const config: SynchronizerDownConfig = {
            source: { ...source, type: 'b2' },
            dest: { ...dest, type: 'local', root },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'error',
              path: 'broken.txt',
              message: 'stream failed',
            }),
          )
          const remaining = await readdir(root)
          expect(remaining.filter((name) => name.endsWith('.partial'))).toEqual([])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('reports downloads configured without a local root', async () => {
      const source = makeMemoryFolder([makeB2SyncPath('rootless.txt', 1000, 3)], 'b2')
      const dest = makeMemoryFolder([], 'local')
      const mockBucket = makeMockBucket()

      const config: SynchronizerDownConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'local', root: '' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
      }

      const events = await collectEvents(config)

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          path: 'rootless.txt',
          message: 'Local sync root required for filesystem mutation',
        }),
      )
    })

    it.skipIf(!isNode)(
      'reports non-ENOENT errors while checking local path components',
      async () => {
        const { mkdtemp, rm } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-lstat-error-'))
        const longSegment = 'a'.repeat(5000)
        const relativePath = `${longSegment}/payload.txt`
        try {
          const source = makeMemoryFolder([makeB2SyncPath(relativePath, 1000, 3)], 'b2')
          const dest = makeMemoryFolder([], 'local')
          const mockBucket = makeMockBucket()

          const config: SynchronizerDownConfig = {
            source: { ...source, type: 'b2' },
            dest: { ...dest, type: 'local', root },
            options: { compareMode: 'modtime', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'error',
              path: relativePath,
            }),
          )
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  describe('encryptionProvider', () => {
    const destinationSse = {
      mode: EncryptionMode.SseB2,
      algorithm: EncryptionAlgorithm.Aes256,
    } as const
    const sourceSse = {
      mode: EncryptionMode.SseC,
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey: 'customer-key',
      customerKeyMd5: 'customer-key-md5',
    } as const
    const noneSse = { mode: EncryptionMode.None } as const

    it.skipIf(!isNode)('passes upload settings to local-to-B2 uploads', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-up-'))
      try {
        const filePath = join(root, 'secret.txt')
        await writeFile(filePath, 'secret')

        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => destinationSse)
        const getSettingForDownload = vi.fn(() => undefined)
        const sourceFile: LocalSyncPath = {
          relativePath: 'secret.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 6,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'encrypted/',
        }

        await collectEvents(config)

        expect(getSettingForUpload).toHaveBeenCalledWith('encrypted/secret.txt', 6)
        expect(getSettingForDownload).not.toHaveBeenCalled()
        expect(mockBucket.upload).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: 'encrypted/secret.txt',
            serverSideEncryption: destinationSse,
          }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('forwards SSE-C upload settings to local-to-B2 uploads', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-c-up-'))
      try {
        const filePath = join(root, 'secret-c.txt')
        await writeFile(filePath, 'secret-c')

        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => sourceSse)
        const getSettingForDownload = vi.fn(() => undefined)
        const sourceFile: LocalSyncPath = {
          relativePath: 'secret-c.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 8,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'encrypted/',
        }

        await collectEvents(config)

        expect(getSettingForUpload).toHaveBeenCalledWith('encrypted/secret-c.txt', 8)
        expect(mockBucket.upload).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: 'encrypted/secret-c.txt',
            serverSideEncryption: sourceSse,
          }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('forwards explicit none upload settings', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-none-up-'))
      try {
        const filePath = join(root, 'none.txt')
        await writeFile(filePath, 'none')

        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => noneSse)
        const getSettingForDownload = vi.fn(() => undefined)
        const sourceFile: LocalSyncPath = {
          relativePath: 'none.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 4,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'encrypted/',
        }

        await collectEvents(config)

        expect(getSettingForUpload).toHaveBeenCalledWith('encrypted/none.txt', 4)
        expect(mockBucket.upload).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: 'encrypted/none.txt',
            serverSideEncryption: noneSse,
          }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('omits upload settings when provider returns undefined', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-up-none-'))
      try {
        const filePath = join(root, 'plain.txt')
        await writeFile(filePath, 'plain')

        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => undefined)
        const getSettingForDownload = vi.fn(() => undefined)
        const sourceFile: LocalSyncPath = {
          relativePath: 'plain.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 5,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'encrypted/',
        }

        await collectEvents(config)

        const uploadOptions = mockBucket.upload.mock.calls[0]?.[0] as
          | Record<string, unknown>
          | undefined
        expect(uploadOptions).toMatchObject({ fileName: 'encrypted/plain.txt' })
        expect(uploadOptions).not.toHaveProperty('serverSideEncryption')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('passes SSE-C download keys to B2-to-local downloads', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-dl-'))
      try {
        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => undefined)
        const getSettingForDownload = vi.fn(() => sourceSse)
        const sourceFile = makeB2SyncPath('secret.txt', 2000, 3)
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
        }

        await collectEvents(config)

        expect(getSettingForDownload).toHaveBeenCalledWith(sourceFile.selectedVersion)
        expect(getSettingForUpload).not.toHaveBeenCalled()
        expect(mockBucket.file).toHaveBeenCalledWith('secret.txt')
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_secret.txt',
          expect.objectContaining({
            serverSideEncryption: sourceSse,
            signal: expect.any(AbortSignal),
          }),
        )
        expect(mockBucket.downloadById.mock.calls[0]?.[1]?.serverSideEncryption).toBe(sourceSse)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('omits download keys for non-SSE-C settings', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sse-dl-none-'))
      try {
        const mockBucket = makeMockBucket()
        const getSettingForUpload = vi.fn(() => undefined)
        const getSettingForDownload = vi.fn(() => destinationSse)
        const sourceFile = makeB2SyncPath('b2-managed.txt', 2000, 3)
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: {
            compareMode: 'modtime',
            keepMode: 'no-delete',
            encryptionProvider: { getSettingForUpload, getSettingForDownload },
          },
          bucket: mockBucket as unknown as Bucket,
        }

        await collectEvents(config)

        expect(getSettingForDownload).toHaveBeenCalledWith(sourceFile.selectedVersion)
        expect(mockBucket.file).toHaveBeenCalledWith('b2-managed.txt')
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_b2-managed.txt',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('passes source and destination settings to B2-to-B2 copies', async () => {
      const mockBucket = makeMockBucket()
      const getSettingForUpload = vi.fn(() => destinationSse)
      const getSettingForDownload = vi.fn(() => sourceSse)
      const sourceFile = makeB2SyncPath('copy.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          encryptionProvider: {
            getSettingForUpload,
            getSettingForDownload,
          } satisfies SyncEncryptionProvider,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      await collectEvents(config)

      expect(getSettingForUpload).toHaveBeenCalledWith('copy.txt', 42)
      expect(getSettingForDownload).toHaveBeenCalledWith(sourceFile.selectedVersion)
      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFileId: sourceFile.selectedVersion.fileId,
          fileName: 'copy.txt',
          destinationServerSideEncryption: destinationSse,
          sourceServerSideEncryption: sourceSse,
          signal: expect.any(AbortSignal),
        }),
      )
    })

    it('omits absent source settings from B2-to-B2 copies', async () => {
      const mockBucket = makeMockBucket()
      const getSettingForUpload = vi.fn(() => destinationSse)
      const getSettingForDownload = vi.fn(() => undefined)
      const sourceFile = makeB2SyncPath('dest-only.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          encryptionProvider: {
            getSettingForUpload,
            getSettingForDownload,
          } satisfies SyncEncryptionProvider,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      await collectEvents(config)

      const copyOptions = mockBucket.copyFile.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined
      expect(copyOptions).toMatchObject({
        sourceFileId: sourceFile.selectedVersion.fileId,
        fileName: 'dest-only.txt',
        destinationServerSideEncryption: destinationSse,
      })
      expect(copyOptions).not.toHaveProperty('sourceServerSideEncryption')
    })

    it('omits absent destination and non-SSE-C source settings from B2-to-B2 copies', async () => {
      const mockBucket = makeMockBucket()
      const getSettingForUpload = vi.fn(() => undefined)
      const getSettingForDownload = vi.fn(() => destinationSse)
      const sourceFile = makeB2SyncPath('b2-managed-copy.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          encryptionProvider: {
            getSettingForUpload,
            getSettingForDownload,
          } satisfies SyncEncryptionProvider,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      await collectEvents(config)

      const copyOptions = mockBucket.copyFile.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined
      expect(copyOptions).toMatchObject({
        sourceFileId: sourceFile.selectedVersion.fileId,
        fileName: 'b2-managed-copy.txt',
      })
      expect(copyOptions).not.toHaveProperty('destinationServerSideEncryption')
      expect(copyOptions).not.toHaveProperty('sourceServerSideEncryption')
    })

    it('emits error events when encryptionProvider throws during copy', async () => {
      const mockBucket = makeMockBucket()
      const getSettingForUpload = vi.fn(() => {
        throw new Error('provider boom')
      })
      const getSettingForDownload = vi.fn(() => undefined)
      const sourceFile = makeB2SyncPath('provider-boom.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          encryptionProvider: {
            getSettingForUpload,
            getSettingForDownload,
          } satisfies SyncEncryptionProvider,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const errors = events.filter((e) => e.type === 'error')

      expect(errors).toHaveLength(2)
      expect(errors[0]?.path).toBe('provider-boom.txt')
      expect(errors[0]?.message).toBe('provider boom')
      expect(errors[1]?.path).toBe('')
      expect(errors[1]?.message).toBe('1 sync error(s) occurred')
      expect(getSettingForDownload).not.toHaveBeenCalled()
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })
  })

  describe('compare modes', () => {
    it("treats files with same size but different modtime as equal under compareMode 'size'", async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeLocalSyncPath('a.txt', 5000, 100)
      const destFile = makeB2SyncPath('a.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skips = events.filter((e) => e.type === 'skip')
      expect(skips).toHaveLength(1)
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })

    it("copies when sizes differ under compareMode 'size' (b2-to-b2)", async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('a.txt', 1000, 200)
      const destFile = makeB2SyncPath('a.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copies = events.filter((e) => e.type === 'copy-done')
      expect(copies).toHaveLength(1)
    })

    it("always treats paired files as equal under compareMode 'none'", async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeLocalSyncPath('a.txt', 9999, 9999)
      const destFile = makeB2SyncPath('a.txt', 1, 1)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'none', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skips = events.filter((e) => e.type === 'skip')
      expect(skips).toHaveLength(1)
      expect(skips[0]?.message).toBe('files are the same')
    })

    it('rejects an unsupported compare mode before scanning source-only files', async () => {
      const mockBucket = makeMockBucket()
      let scanned = false
      const sourceFile = makeLocalSyncPath('a.txt', 1000, 3)
      const source: SyncFolder = {
        type: 'local',
        async *scan() {
          scanned = true
          yield sourceFile
        },
      }
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha256' as never, keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      await expect(collectEvents(config)).rejects.toThrow('Unsupported compare mode')
      expect(scanned).toBe(false)
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)(
      "uploads when sha1 differs under compareMode 'sha1' despite matching metadata",
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-up-'))
        try {
          const filePath = join(root, 'drift.txt')
          await writeFile(filePath, 'abc')

          const mockBucket = makeMockBucket()
          const sourceFile: LocalSyncPath = {
            relativePath: 'drift.txt',
            absolutePath: filePath,
            modTimeMillis: 1000,
            size: 3,
          }
          const destFile = makeB2SyncPath('drift.txt', 1000, 3, undefined, '0'.repeat(40))
          const source = makeMemoryFolder([sourceFile], 'local')
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'sha1', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          const uploads = events.filter((e) => e.type === 'upload-done')
          expect(uploads).toHaveLength(1)
          expect(mockBucket.upload).toHaveBeenCalledTimes(1)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)("skips when sha1 matches under compareMode 'sha1'", async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-same-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'same.txt')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket({ 'fid_same.txt': data })
        const sourceFile: LocalSyncPath = {
          relativePath: 'same.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath(
          'same.txt',
          2000,
          data.byteLength,
          undefined,
          await sha1Hex(data),
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const skips = events.filter((e) => e.type === 'skip')
        expect(skips).toHaveLength(1)
        expect(skips[0]?.message).toBe('files are the same')
        expect(mockBucket.downloadById).not.toHaveBeenCalled()
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'uses B2 large_file_sha1 fallback to avoid re-uploading unchanged large files',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-large-'))
        try {
          const data = new TextEncoder().encode('large-file-content')
          const filePath = join(root, 'large.bin')
          await writeFile(filePath, data)

          const mockBucket = makeMockBucket({ 'fid_large.bin': data })
          const sourceFile: LocalSyncPath = {
            relativePath: 'large.bin',
            absolutePath: filePath,
            modTimeMillis: 1000,
            size: data.byteLength,
          }
          const largeFileSha1 = await sha1Hex(data)
          const destFile = makeB2SyncPath(
            'large.bin',
            1000,
            data.byteLength,
            undefined,
            null,
            { large_file_sha1: largeFileSha1 },
            `unverified:${largeFileSha1}`,
          )
          const source = makeMemoryFolder([sourceFile], 'local')
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'sha1', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const firstRun = await collectEvents(config)
          const secondRun = await collectEvents(config)

          expect(firstRun.filter((e) => e.type === 'skip')).toHaveLength(1)
          expect(secondRun.filter((e) => e.type === 'skip')).toHaveLength(1)
          expect(firstRun.find(isCompareEvent)?.bytesVerified).toBe(data.byteLength)
          expect(secondRun.find(isCompareEvent)?.bytesVerified).toBe(data.byteLength)
          expect(firstRun.filter((e) => e.type === 'error')).toHaveLength(0)
          expect(secondRun.filter((e) => e.type === 'error')).toHaveLength(0)
          expect(mockBucket.upload).not.toHaveBeenCalled()
          expect(mockBucket.downloadById).toHaveBeenCalledTimes(2)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('verifies untrusted B2 sha1 against the scanned file ID', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-file-id-'))
      try {
        const localData = new TextEncoder().encode('abc')
        const newerDataAtName = new TextEncoder().encode('xyz')
        const filePath = join(root, 'stable.txt')
        await writeFile(filePath, localData)

        const mockBucket = makeMockBucket({
          'fid_stable.txt': localData,
          'stable.txt': newerDataAtName,
        })
        const sha1 = await sha1Hex(localData)
        const sourceFile: LocalSyncPath = {
          relativePath: 'stable.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: localData.byteLength,
        }
        const destFile = makeB2SyncPath(
          'stable.txt',
          1000,
          localData.byteLength,
          undefined,
          null,
          { large_file_sha1: sha1 },
          `unverified:${sha1}`,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'skip')).toHaveLength(1)
        expect(mockBucket.file).toHaveBeenCalledWith('stable.txt')
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_stable.txt',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        expect(mockBucket.download).not.toHaveBeenCalled()
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('uploads when forged B2 large_file_sha1 matches local bytes', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-forged-large-'))
      try {
        const localData = new TextEncoder().encode('abc')
        const remoteData = new TextEncoder().encode('xyz')
        const filePath = join(root, 'large.bin')
        await writeFile(filePath, localData)

        const mockBucket = makeMockBucket({ 'fid_large.bin': remoteData })
        const sourceFile: LocalSyncPath = {
          relativePath: 'large.bin',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: localData.byteLength,
        }
        const forgedSha1 = await sha1Hex(localData)
        const destFile = makeB2SyncPath(
          'large.bin',
          1000,
          localData.byteLength,
          undefined,
          null,
          { large_file_sha1: forgedSha1 },
          `unverified:${forgedSha1}`,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'skip')).toHaveLength(0)
        expect(mockBucket.downloadById).toHaveBeenCalledTimes(1)
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_large.bin',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'skips without B2 download when authoritative B2 contentSha1 matches local bytes',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-authoritative-'))
        try {
          const localData = new TextEncoder().encode('abc')
          const filePath = join(root, 'authoritative.txt')
          await writeFile(filePath, localData)

          const mockBucket = makeMockBucket()
          const contentSha1 = await sha1Hex(localData)
          const sourceFile: LocalSyncPath = {
            relativePath: 'authoritative.txt',
            absolutePath: filePath,
            modTimeMillis: 1000,
            size: localData.byteLength,
          }
          const destFile = makeB2SyncPath(
            'authoritative.txt',
            1000,
            localData.byteLength,
            undefined,
            contentSha1,
          )
          const source = makeMemoryFolder([sourceFile], 'local')
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'sha1', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          expect(events.filter((e) => e.type === 'skip')).toHaveLength(1)
          expect(mockBucket.downloadById).not.toHaveBeenCalled()
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('skips when verifying matching B2 metadata bytes fails', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-b2-read-error-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'remote-read-error.txt')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket()
        mockBucket.downloadById.mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('remote stream failed'))
            },
          }),
        })
        const sourceFile: LocalSyncPath = {
          relativePath: 'remote-read-error.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath(
          'remote-read-error.txt',
          1000,
          data.byteLength,
          undefined,
          null,
          { large_file_sha1: await sha1Hex(data) },
          `unverified:${await sha1Hex(data)}`,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const errors = events.filter((e) => e.type === 'error')
        const skips = events.filter((e) => e.type === 'skip')
        expect(errors).toHaveLength(0)
        expect(skips[0]?.path).toBe('remote-read-error.txt')
        expect(skips[0]?.message).toContain('B2 verification failed')
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('surfaces a timeout for a stalled B2 sha1 response body', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.downloadById.mockResolvedValue({
        body: new ReadableStream<Uint8Array>({
          start() {},
        }),
      })
      const sha1 = await sha1Hex(new TextEncoder().encode('abc'))
      const sourceFile = makeB2SyncPath(
        'remote-stall.txt',
        1000,
        3,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath('remote-stall.txt', 1000, 3, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', sha1ReadTimeoutMillis: 1 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const errors = events.filter((e) => e.type === 'error')
      const skips = events.filter((e) => e.type === 'skip')
      expect(errors).toHaveLength(0)
      expect(skips[0]?.path).toBe('remote-stall.txt')
      expect(skips[0]?.message).toContain('sha1 B2 read stalled')
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)('does not wait forever when B2 sha1 stream cancel hangs', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.downloadById.mockResolvedValue({
        body: new ReadableStream<Uint8Array>({
          start() {},
          cancel: () => new Promise(() => {}),
        }),
      })
      const sha1 = await sha1Hex(new TextEncoder().encode('abc'))
      const sourceFile = makeB2SyncPath(
        'remote-cancel-stall.txt',
        1000,
        3,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath('remote-cancel-stall.txt', 1000, 3, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', sha1ReadTimeoutMillis: 1 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for cancel')), 1000)
      })
      const events = await Promise.race([collectEvents(config), timeout])
      expect(events.some((event) => event.type === 'skip')).toBe(true)
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('skips when B2 sha1 verification exceeds the byte budget', async () => {
      const mockBucket = makeMockBucket({ 'fid_remote-budget.txt': new Uint8Array([1, 2, 3, 4]) })
      const sha1 = await sha1Hex(new Uint8Array([1, 2, 3]))
      const sourceFile = makeB2SyncPath(
        'remote-budget.txt',
        1000,
        3,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath('remote-budget.txt', 1000, 3, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)
      const errors = events.filter((event) => event.type === 'error')
      const skips = events.filter((event) => event.type === 'skip')
      expect(errors).toHaveLength(0)
      expect(skips[0]?.path).toBe('remote-budget.txt')
      expect(skips[0]?.message).toContain('sha1 B2 read exceeded 3 byte verification budget')
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('skips when B2 sha1 verification exceeds an explicit byte ceiling', async () => {
      const mockBucket = makeMockBucket({ 'fid_remote-ceiling.txt': new Uint8Array([1, 2, 3]) })
      const sha1 = await sha1Hex(new Uint8Array([1, 2, 3]))
      const sourceFile = makeB2SyncPath(
        'remote-ceiling.txt',
        1000,
        3,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath('remote-ceiling.txt', 1000, 3, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'sha1',
          keepMode: 'no-delete',
          sha1VerificationMaxBytes: 2,
        },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)
      const errors = events.filter((event) => event.type === 'error')
      const skips = events.filter((event) => event.type === 'skip')
      expect(errors).toHaveLength(0)
      expect(skips[0]?.message).toContain(
        'sha1 B2 verification skipped because contentLength 3 exceeds 2 byte verification budget',
      )
      expect(mockBucket.downloadById).not.toHaveBeenCalled()
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('skips when B2 sha1 verification ends before contentLength', async () => {
      const actual = new Uint8Array([1, 2, 3])
      const expected = new Uint8Array([1, 2, 3, 4])
      const mockBucket = makeMockBucket({ 'fid_remote-short.txt': actual })
      const sha1 = await sha1Hex(expected)
      const sourceFile = makeB2SyncPath(
        'remote-short.txt',
        1000,
        expected.byteLength,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath(
        'remote-short.txt',
        1000,
        expected.byteLength,
        undefined,
        sha1,
      )
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)
      const errors = events.filter((event) => event.type === 'error')
      const skips = events.filter((event) => event.type === 'skip')
      expect(errors).toHaveLength(0)
      expect(skips[0]?.message).toContain('sha1 B2 read ended after 3 bytes, expected 4')
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('ignores invalid B2 sha1 verification byte ceilings', async () => {
      const data = new Uint8Array([1, 2, 3])
      const mockBucket = makeMockBucket({ 'fid_remote-invalid-ceiling.txt': data })
      const sha1 = await sha1Hex(data)
      const sourceFile = makeB2SyncPath(
        'remote-invalid-ceiling.txt',
        1000,
        data.byteLength,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath(
        'remote-invalid-ceiling.txt',
        1000,
        data.byteLength,
        undefined,
        sha1,
      )
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'sha1',
          keepMode: 'no-delete',
          sha1VerificationMaxBytes: Number.NaN,
        },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)
      expect(events.filter((event) => event.type === 'skip')).toHaveLength(1)
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('skips when the B2 sha1 download request exceeds the deadline', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.downloadById.mockImplementation(() => new Promise(() => {}))
      const sha1 = await sha1Hex(new Uint8Array([1, 2, 3]))
      const sourceFile = makeB2SyncPath(
        'remote-deadline.txt',
        1000,
        3,
        undefined,
        null,
        { large_file_sha1: sha1 },
        `unverified:${sha1}`,
      )
      const destFile = makeB2SyncPath('remote-deadline.txt', 1000, 3, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'sha1',
          keepMode: 'no-delete',
          sha1VerificationTimeoutMillis: 1,
        },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)
      const errors = events.filter((event) => event.type === 'error')
      const skips = events.filter((event) => event.type === 'skip')
      expect(errors).toHaveLength(0)
      expect(skips[0]?.path).toBe('remote-deadline.txt')
      expect(skips[0]?.message).toContain('sha1 B2 verification exceeded 1 ms')
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)('uploads when B2 large_file_sha1 differs', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-large-diff-'))
      try {
        const data = new TextEncoder().encode('large-file-content')
        const filePath = join(root, 'large.bin')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'large.bin',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const largeFileSha1 = '0'.repeat(40)
        const destFile = makeB2SyncPath(
          'large.bin',
          1000,
          data.byteLength,
          undefined,
          null,
          { large_file_sha1: largeFileSha1 },
          `unverified:${largeFileSha1}`,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('skips when sha1 comparison has no verifiable B2 hash', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-unavailable-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'unknown.txt')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'unknown.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath('unknown.txt', 1000, data.byteLength, undefined, null)
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const skips = events.filter((e) => e.type === 'skip')
        expect(skips).toHaveLength(1)
        expect(skips[0]).toMatchObject({
          path: 'unknown.txt',
          message: expect.stringContaining('verifiable SHA-1 is unavailable'),
        })
        expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('does not trust unverified B2 sha1 metadata', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-untrusted-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'tampered.txt')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'tampered.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath(
          'tampered.txt',
          1000,
          data.byteLength,
          undefined,
          `unverified:${await sha1Hex(data)}`,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('uses scanner-supplied local contentSha1 without hashing', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-spoofed-local-'))
      try {
        const localData = new TextEncoder().encode('bad')
        const remoteData = new TextEncoder().encode('abc')
        const filePath = join(root, 'config.json')
        await writeFile(filePath, localData)

        const fakeSha1 = await sha1Hex(remoteData)
        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'config.json',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: localData.byteLength,
          contentSha1: fakeSha1,
        }
        const destFile = makeB2SyncPath(
          'config.json',
          1000,
          localData.byteLength,
          undefined,
          fakeSha1,
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(0)
        expect(events.find(isCompareEvent)?.bytesHashed).toBe(0)
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('continues after a local file cannot be hashed', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, unlink, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-read-error-'))
      try {
        const badPath = join(root, 'gone.txt')
        const goodPath = join(root, 'good.txt')
        await writeFile(badPath, 'abc')
        await writeFile(goodPath, 'abc')
        await unlink(badPath)

        const mockBucket = makeMockBucket()
        const sourceFiles: LocalSyncPath[] = [
          {
            relativePath: 'gone.txt',
            absolutePath: badPath,
            modTimeMillis: 1000,
            size: 3,
          },
          {
            relativePath: 'good.txt',
            absolutePath: goodPath,
            modTimeMillis: 1000,
            size: 3,
          },
        ]
        const source = makeMemoryFolder(sourceFiles, 'local')
        const dest = makeMemoryFolder(
          [
            makeB2SyncPath('gone.txt', 1000, 3, undefined, '0'.repeat(40)),
            makeB2SyncPath('good.txt', 1000, 3, undefined, '0'.repeat(40)),
          ],
          'b2',
        )

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const errors = events.filter((e) => e.type === 'error')
        expect(errors).toHaveLength(2)
        expect(errors[0]?.path).toBe('gone.txt')
        expect(errors[0]?.message).toContain('failed to hash local file')
        expect(errors[0]?.message).not.toContain(badPath)
        expect(errors[0]?.message).not.toContain(root)
        expect(errors[1]?.path).toBe('')
        expect(errors[1]?.message).toBe('1 sync error(s) occurred')
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)(
      'reports a per-file error for non-regular local files',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-nonregular-'))
        try {
          const targetPath = join(root, 'target.txt')
          const linkPath = join(root, 'linked.txt')
          await writeFile(targetPath, 'abc')
          await symlink(targetPath, linkPath)

          const mockBucket = makeMockBucket()
          const sourceFile: LocalSyncPath = {
            relativePath: 'linked.txt',
            absolutePath: linkPath,
            modTimeMillis: 1000,
            size: 3,
          }
          const destFile = makeB2SyncPath('linked.txt', 1000, 3, undefined, '0'.repeat(40))
          const source = makeMemoryFolder([sourceFile], 'local')
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'sha1', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          const events = await collectEvents(config)
          const errors = events.filter((e) => e.type === 'error')
          expect(errors[0]?.path).toBe('linked.txt')
          expect(errors[0]?.message).toContain('failed to hash local file')
          expect(errors[0]?.message).not.toContain(linkPath)
          expect(mockBucket.upload).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode || isWindows)('reports a per-file error for local FIFOs', async () => {
      const { execFile } = await import('node:child_process')
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const { promisify } = await import('node:util')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-fifo-'))
      try {
        const fifoPath = join(root, 'pipe.txt')
        await promisify(execFile)('mkfifo', [fifoPath])

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'pipe.txt',
          absolutePath: fifoPath,
          modTimeMillis: 1000,
          size: 0,
        }
        const destFile = makeB2SyncPath('pipe.txt', 1000, 0, undefined, '0'.repeat(40))
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for FIFO rejection')), 1500)
        })
        const events = await Promise.race([collectEvents(config), timeout])
        const errors = events.filter((e) => e.type === 'error')
        expect(errors[0]?.path).toBe('pipe.txt')
        expect(errors[0]?.message).toContain('failed to hash local file')
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('does not hash when size already proves sha1 drift', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile: LocalSyncPath = {
        relativePath: 'missing.txt',
        absolutePath: '/not/a/real/file',
        modTimeMillis: 1000,
        size: 3,
      }
      const destFile = makeB2SyncPath('missing.txt', 1000, 4, undefined, '0'.repeat(40))
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
      expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
      expect(events.find(isCompareEvent)?.bytesHashed).toBe(0)
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })

    it.skipIf(!isNode)('emits hashed bytes for sha1 dry-run comparisons', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-dry-run-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'changed.txt')
        await writeFile(filePath, data)

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'changed.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath(
          'changed.txt',
          1000,
          data.byteLength,
          undefined,
          '0'.repeat(40),
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete', dryRun: true },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const events = await collectEvents(config)
        const compare = events.find(isCompareEvent)
        expect(compare?.size).toBe(0)
        expect(compare?.bytesHashed).toBe(data.byteLength)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('does not download untrusted B2 bytes during sha1 dry-run', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-dry-b2-'))
      try {
        const data = new TextEncoder().encode('abc')
        const filePath = join(root, 'large.bin')
        await writeFile(filePath, data)
        const sha1 = await sha1Hex(data)
        const mockBucket = makeMockBucket({ 'fid_large.bin': data })
        const sourceFile: LocalSyncPath = {
          relativePath: 'large.bin',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const destFile = makeB2SyncPath(
          'large.bin',
          1000,
          data.byteLength,
          undefined,
          null,
          { large_file_sha1: sha1 },
          `unverified:${sha1}`,
        )

        const config: SynchronizerUpConfig = {
          source: { ...makeMemoryFolder([sourceFile], 'local'), type: 'local', root },
          dest: { ...makeMemoryFolder([destFile], 'b2'), type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete', dryRun: true },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }
        const events = await collectEvents(config)

        expect(events.filter((event) => event.type === 'upload-done')).toHaveLength(1)
        expect(events.find(isCompareEvent)?.bytesHashed).toBe(data.byteLength)
        expect(events.find(isCompareEvent)?.bytesVerified).toBeUndefined()
        expect(mockBucket.downloadById).not.toHaveBeenCalled()
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('scans the full inventory before preparing sha1 batches', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-batch-'))
      try {
        const data = new TextEncoder().encode('abc')
        const sourceFiles: LocalSyncPath[] = []
        const destFiles: B2SyncPath[] = []
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
          const filePath = join(root, name)
          await writeFile(filePath, data)
          sourceFiles.push({
            relativePath: name,
            absolutePath: filePath,
            modTimeMillis: 1000,
            size: data.byteLength,
          })
          destFiles.push(makeB2SyncPath(name, 1000, data.byteLength, undefined, '0'.repeat(40)))
        }

        let sourceScans = 0
        const source: SyncFolder = {
          type: 'local',
          appliesScanSorting: true,
          async *scan() {
            for (const file of sourceFiles) {
              sourceScans += 1
              yield file
            }
          },
        }
        const dest = makeMemoryFolder(destFiles, 'b2')
        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'sha1', keepMode: 'no-delete', concurrency: 2 },
          bucket: makeMockBucket() as unknown as Bucket,
          prefix: '',
        }

        const iterator = synchronize(config)
        const first = await iterator.next()
        expect(first.done).toBe(false)
        expect(first.value?.type).toBe('compare')
        expect(sourceScans).toBe(3)
        await iterator.return?.(undefined)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('aborts while hashing a local file', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, open, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const controller = new AbortController()
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-abort-'))
      try {
        const abortHashFileSize = 32 * 1024 * 1024
        const filePath = join(root, 'large.bin')
        const file = await open(filePath, 'w')
        await file.truncate(abortHashFileSize)
        await file.close()

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'large.bin',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: abortHashFileSize,
        }
        const destFile = makeB2SyncPath(
          'large.bin',
          1000,
          abortHashFileSize,
          undefined,
          'a'.repeat(40),
        )
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')
        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: {
            compareMode: 'sha1',
            keepMode: 'no-delete',
            signal: controller.signal,
          },
          bucket: mockBucket as unknown as Bucket,
          prefix: '',
        }

        const abortTimer = setTimeout(() => controller.abort(), 0)
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for abort')), 2000)
        })

        await expect(Promise.race([collectEvents(config), timeout])).resolves.toEqual([])
        clearTimeout(abortTimer)
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('downloads when sha1 differs in b2-to-local mode', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-down-'))
      try {
        const localPath = join(root, 'remote.txt')
        await writeFile(localPath, 'xyz')

        const remoteData = new TextEncoder().encode('abc')
        const newerDataAtName = new TextEncoder().encode('new')
        const mockBucket = makeMockBucket({
          'fid_remote.txt': remoteData,
          'remote.txt': newerDataAtName,
        })
        const sourceFile = makeB2SyncPath(
          'remote.txt',
          1000,
          remoteData.byteLength,
          undefined,
          await sha1Hex(remoteData),
        )
        const destFile: LocalSyncPath = {
          relativePath: 'remote.txt',
          absolutePath: localPath,
          modTimeMillis: 1000,
          size: remoteData.byteLength,
        }
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([destFile], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        expect(events.filter((e) => e.type === 'download-done')).toHaveLength(1)
        expect(mockBucket.downloadById).toHaveBeenCalledTimes(1)
        expect(mockBucket.downloadById).toHaveBeenCalledWith(
          'fid_remote.txt',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
        await expect(readFile(localPath)).resolves.toEqual(Buffer.from(remoteData))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('skips when sha1 matches in b2-to-local mode', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-down-same-'))
      try {
        const data = new TextEncoder().encode('abc')
        const localPath = join(root, 'remote.txt')
        await writeFile(localPath, data)

        const mockBucket = makeMockBucket({ 'fid_remote.txt': data })
        const sourceFile = makeB2SyncPath(
          'remote.txt',
          1000,
          data.byteLength,
          undefined,
          await sha1Hex(data),
        )
        const destFile: LocalSyncPath = {
          relativePath: 'remote.txt',
          absolutePath: localPath,
          modTimeMillis: 1000,
          size: data.byteLength,
        }
        const source = makeMemoryFolder([sourceFile], 'b2')
        const dest = makeMemoryFolder([destFile], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'sha1', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        const skips = events.filter((e) => e.type === 'skip')
        expect(skips).toHaveLength(1)
        expect(skips[0]?.message).toBe('files are the same')
        expect(mockBucket.download).not.toHaveBeenCalled()
        expect(mockBucket.downloadById).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('copies when sha1 differs in b2-to-b2 mode', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('cloud.txt', 1000, 100, undefined, 'a'.repeat(40))
      const destFile = makeB2SyncPath('cloud.txt', 1000, 100, undefined, 'b'.repeat(40))
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      expect(events.filter((e) => e.type === 'copy-done')).toHaveLength(1)
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)
    })

    it('skips when sha1 matches in b2-to-b2 mode', async () => {
      const mockBucket = makeMockBucket()
      const sha1 = 'a'.repeat(40)
      const sourceFile = makeB2SyncPath('cloud.txt', 1000, 100, undefined, sha1)
      const destFile = makeB2SyncPath('cloud.txt', 1000, 100, undefined, sha1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      expect(events.filter((e) => e.type === 'skip')).toHaveLength(1)
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('honors a non-zero compareThreshold for modtime', async () => {
      const mockBucket = makeMockBucket()
      // Drift smaller than threshold should be treated as equal.
      const sourceFile = makeLocalSyncPath('a.txt', 1500, 100)
      const destFile = makeB2SyncPath('a.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          compareThreshold: 1000,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const skips = events.filter((e) => e.type === 'skip')
      expect(skips).toHaveLength(1)
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })

    it('copies when modtime drift exceeds compareThreshold (b2-to-b2 path skips fs)', async () => {
      const mockBucket = makeMockBucket()
      // Use b2-to-b2 to avoid touching the local fs in the upload closure.
      const sourceFile = makeB2SyncPath('a.txt', 5000, 100)
      const destFile = makeB2SyncPath('a.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          compareThreshold: 100,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copies = events.filter((e) => e.type === 'copy-done')
      expect(copies).toHaveLength(1)
    })
  })

  describe('b2-to-b2 direction', () => {
    it('copies a source-only file from one B2 location to another', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('copied.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copyEvents = events.filter((e) => e.type === 'copy-done')
      expect(copyEvents).toHaveLength(1)
      expect(copyEvents[0]?.path).toBe('copied.txt')
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)
      const copyOptions = mockBucket.copyFile.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined
      expect(copyOptions).not.toHaveProperty('destinationServerSideEncryption')
      expect(copyOptions).not.toHaveProperty('sourceServerSideEncryption')
    })

    it('copies source-only files into the destination B2 prefix', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('a.txt', 1000, 42, 'src/a.txt')
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = new B2Folder(mockBucket as unknown as Bucket, 'dst/')

      const config = {
        source: { ...source, type: 'b2' },
        dest,
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      await collectEvents(config)

      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFileId: sourceFile.selectedVersion.fileId,
          fileName: 'dst/a.txt',
        }),
      )
    })

    it('preserves B2 objects with Windows-reserved basenames in b2-to-b2 sync', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('aux.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)

      expect(events).toContainEqual(expect.objectContaining({ type: 'copy-done', path: 'aux.txt' }))
      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'aux.txt' }),
      )
    })

    it('passes abort signals to B2 copy transfers', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('copy-signal.txt', 1000, 42)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          signal: controller.signal,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      await collectEvents(config)

      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'copy-signal.txt',
          signal: expect.any(AbortSignal),
        }),
      )
    })

    it('copies a paired-but-different file in b2-to-b2 mode', async () => {
      const mockBucket = makeMockBucket()
      const controller = new AbortController()
      const sourceFile = makeB2SyncPath('paired.txt', 5000, 100)
      const destFile = makeB2SyncPath('paired.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', signal: controller.signal },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copyEvents = events.filter((e) => e.type === 'copy-done')
      expect(copyEvents).toHaveLength(1)
      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'paired.txt', signal: expect.any(AbortSignal) }),
      )
    })

    it('copies paired replacements to the existing destination B2 key', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('a.txt', 5000, 100, 'src/a.txt')
      const destFile = makeB2SyncPath('a.txt', 1000, 100, 'dst/a.txt')
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = {
        ...makeMemoryFolder([destFile], 'b2'),
        type: 'b2' as const,
        rawPrefix: 'dst/',
      }

      const config = {
        source: { ...source, type: 'b2' },
        dest,
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      await collectEvents(config)

      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFileId: sourceFile.selectedVersion.fileId,
          fileName: 'dst/a.txt',
        }),
      )
    })

    it('deletes orphan dest files in b2-to-b2 with delete mode', async () => {
      const mockBucket = makeMockBucket()
      const destFile = makeB2SyncPath('orphan.txt', 1000, 50)
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const deletes = events.filter((e) => e.type === 'delete-remote')
      expect(deletes).toHaveLength(1)
      expect(mockBucket.deleteFileVersion).toHaveBeenCalledTimes(1)
    })

    it('dry-runs a b2-to-b2 copy without calling the bucket', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('dryc.txt', 1000, 10)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copyEvents = events.filter((e) => e.type === 'copy-done')
      expect(copyEvents).toHaveLength(1)
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })
  })

  describe('keep-days age-based deletion', () => {
    it('deletes orphans older than keepDays in upload direction', async () => {
      const mockBucket = makeMockBucket()
      const oldTime = daysFromNow(-30) // 30 days ago
      const destFile = makeB2SyncPath('stale.txt', oldTime, 50)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'keep-days', keepDays: 7 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // Files older than keepDays fall through to the delete branch.
      // On a vanilla bucket (no file-lock), removeOrphan picks
      // `deleteRemote` only — no hide marker.
      const hides = events.filter((e) => e.type === 'hide')
      const deletes = events.filter((e) => e.type === 'delete-remote')
      expect(hides).toHaveLength(0)
      expect(deletes).toHaveLength(1)
      expect(mockBucket.hideFile).not.toHaveBeenCalled()
      expect(mockBucket.deleteFileVersion).toHaveBeenCalledTimes(1)
    })
  })

  describe('download direction with deletion', () => {
    it.skipIf(!isNode)('deletes orphan local files with delete keep mode', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile, stat } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-rm-'))
      try {
        const filePath = join(root, 'gone.txt')
        await writeFile(filePath, 'bye')

        const mockBucket = makeMockBucket()
        const destFile: LocalSyncPath = {
          relativePath: 'gone.txt',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: 3,
        }
        const source = makeMemoryFolder([], 'b2')
        const dest = makeMemoryFolder([destFile], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: mockBucket as unknown as Bucket,
        }

        const events = await collectEvents(config)
        const deletes = events.filter((e) => e.type === 'delete-local')
        expect(deletes).toHaveLength(1)
        await expect(stat(filePath)).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode || isWindows)(
      'keeps local files when matching B2 source names are skipped as unsafe',
      async () => {
        const { access, mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const { LocalFolder } = await import('./scanners/local.ts')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-unsafe-delete-'))
        try {
          const localPath = join(root, 'CON')
          await writeFile(localPath, 'keep me')
          const fileVersion = makeB2SyncPath('CON', 1000, 7).selectedVersion
          const mockBucket = {
            ...makeMockBucket(),
            listFileVersions: vi.fn().mockResolvedValue({
              files: [fileVersion],
              nextFileName: null,
              nextFileId: null,
            }),
          }

          const config: SynchronizerDownConfig = {
            source: new B2Folder(mockBucket as unknown as Bucket),
            dest: new LocalFolder(root),
            options: { compareMode: 'modtime', keepMode: 'delete' },
            bucket: mockBucket as unknown as Bucket,
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'skip',
              reason: 'local-unsafe-name',
              path: 'CON',
            }),
          )
          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'skip',
              path: 'CON',
              message: 'not removed because the source scan skipped unsafe B2 names',
            }),
          )
          expect(events.some((event) => event.type === 'delete-local')).toBe(false)
          await expect(access(localPath)).resolves.toBeUndefined()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it.skipIf(!isNode)('sanitizes local delete filesystem errors', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-delete-error-'))
      try {
        const dirPath = join(root, 'orphan-dir')
        await mkdir(dirPath)
        const source = makeMemoryFolder([], 'b2')
        const destPath: LocalSyncPath = {
          relativePath: 'orphan-dir',
          absolutePath: dirPath,
          modTimeMillis: 1000,
          size: 0,
        }
        const dest = makeMemoryFolder([destPath], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: makeMockBucket() as unknown as Bucket,
        }

        const events = await collectEvents(config)
        const error = events.find(
          (event): event is Extract<SyncEvent, { type: 'error' }> =>
            event.type === 'error' && event.path === 'orphan-dir',
        )

        expect(error?.message).toMatch(/^failed to delete local file: (EACCES|EISDIR|EPERM)$/)
        expect(error?.message).not.toContain(root)
        expect(error?.message).not.toContain(dirPath)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('refuses local deletes outside the sync root', async () => {
      const { access, mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { basename, dirname, join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-delete-root-'))
      const outsidePath = join(dirname(root), `${basename(root)}-escape-delete.txt`)
      try {
        await writeFile(outsidePath, 'keep')
        const source = makeMemoryFolder([], 'b2')
        const destPath: LocalSyncPath = {
          relativePath: '../escape-delete.txt',
          absolutePath: outsidePath,
          modTimeMillis: 1000,
          size: 4,
        }
        const dest = makeMemoryFolder([destPath], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: makeMockBucket() as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: '../escape-delete.txt',
          }),
        )
        await expect(access(outsidePath).then(() => true)).resolves.toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(outsidePath, { force: true })
      }
    })

    it.skipIf(!isNode)('refuses local deletes when the scanner absolute path differs', async () => {
      const { access, mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-delete-mismatch-'))
      const mismatchedPath = join(root, 'other.txt')
      try {
        await writeFile(mismatchedPath, 'keep')
        const source = makeMemoryFolder([], 'b2')
        const destPath: LocalSyncPath = {
          relativePath: 'orphan.txt',
          absolutePath: mismatchedPath,
          modTimeMillis: 1000,
          size: 4,
        }
        const dest = makeMemoryFolder([destPath], 'local')

        const config: SynchronizerDownConfig = {
          source: { ...source, type: 'b2' },
          dest: { ...dest, type: 'local', root },
          options: { compareMode: 'modtime', keepMode: 'delete' },
          bucket: makeMockBucket() as unknown as Bucket,
        }

        const events = await collectEvents(config)

        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'error',
            path: 'orphan.txt',
            message: 'Refusing to delete outside sync root: orphan.txt',
          }),
        )
        await expect(access(mismatchedPath).then(() => true)).resolves.toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('dry-runs a b2-to-local delete-local without touching the filesystem', async () => {
      const mockBucket = makeMockBucket()
      const destFile = makeLocalSyncPath('phantom.txt', 1000, 10)
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([destFile], 'local')

      const config: SynchronizerDownConfig = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'local', root: '/nonexistent-root' },
        options: { compareMode: 'modtime', keepMode: 'delete', dryRun: true },
        bucket: mockBucket as unknown as Bucket,
      }

      const events = await collectEvents(config)
      const deletes = events.filter((e) => e.type === 'delete-local')
      expect(deletes).toHaveLength(1)
    })
  })

  describe('error propagation', () => {
    it('emits an error event when an action throws and a summary error event', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.copyFile = vi.fn().mockRejectedValue(new Error('copy boom'))

      const sourceFile = makeB2SyncPath('fail.txt', 2000, 100)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const errors = events.filter((e) => e.type === 'error')
      // One per-action error event and one summary error event.
      expect(errors).toHaveLength(2)
      expect(errors[0]?.path).toBe('fail.txt')
      expect(errors[0]?.message).toBe('copy boom')
      expect(errors[1]?.path).toBe('')
      expect(errors[1]?.message).toContain('1 sync error(s) occurred')
      expect(errors[1]).toMatchObject({
        failureCount: 1,
        failedPaths: ['fail.txt'],
      })
      expect(errors[1]).not.toHaveProperty('failedPathOmittedCount')
    })

    it('deduplicates failed paths on aggregate error events', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.copyFile = vi.fn().mockRejectedValue(new Error('copy boom'))

      const source = makeMemoryFolder(
        [makeB2SyncPath('repeat.txt', 2000, 100), makeB2SyncPath('repeat.txt', 2000, 100)],
        'b2',
      )
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const summary = events.find(
        (event): event is Extract<SyncEvent, { type: 'error' }> =>
          event.type === 'error' && event.path === '',
      )

      expect(summary).toMatchObject({
        failureCount: 2,
        failedPaths: ['repeat.txt'],
      })
      expect(summary).not.toHaveProperty('failedPathOmittedCount')
    })

    it('bounds failed paths on aggregate error events', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.copyFile = vi.fn().mockRejectedValue(new Error('copy boom'))

      const source = makeMemoryFolder(
        Array.from({ length: 101 }, (_, index) =>
          makeB2SyncPath(`fail-${index.toString().padStart(3, '0')}.txt`, 2000, 100),
        ),
        'b2',
      )
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const summary = events.find(
        (event): event is Extract<SyncEvent, { type: 'error' }> =>
          event.type === 'error' && event.path === '',
      )

      expect(summary).toMatchObject({
        failureCount: 101,
        failedPathOmittedCount: 1,
      })
      expect(summary?.failedPaths).toHaveLength(100)
      expect(summary?.failedPaths?.[0]).toBe('fail-000.txt')
    })

    it('wraps a non-Error thrown value as a string', async () => {
      const mockBucket = makeMockBucket()
      // Reject with a non-Error value to exercise the `String(err)` branch.
      mockBucket.copyFile = vi.fn().mockImplementation(() => Promise.reject('plain-string-failure'))

      const sourceFile = makeB2SyncPath('weird.txt', 2000, 1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const errors = events.filter((e) => e.type === 'error')
      expect(errors.length).toBeGreaterThanOrEqual(2)
      expect(errors[0]?.message).toBe('plain-string-failure')
    })

    it('sanitizes action error messages before emitting events', async () => {
      const mockBucket = makeMockBucket()
      mockBucket.copyFile = vi
        .fn()
        .mockRejectedValue(new Error("\x1b[2J ENOENT: open '/tmp/secret.txt'\nforged"))

      const sourceFile = makeB2SyncPath('sanitized.txt', 2000, 1)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const errors = events.filter((e) => e.type === 'error')
      expect(errors[0]?.message).toBe('Error')
      expect(errors[0]?.message).not.toContain('/tmp/secret')
      expect(errors[0]?.message).not.toContain('\x1b')
      expect(errors[0]?.message).not.toContain('\n')
    })

    it.skipIf(!isNode)(
      'does not execute mutating actions when a streaming scan later fails',
      async () => {
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-scan-error-'))
        const filePath = join(root, 'started.txt')

        try {
          await writeFile(filePath, 'started')
          const mockBucket = makeMockBucket()
          const sourceFile: LocalSyncPath = {
            relativePath: 'started.txt',
            absolutePath: filePath,
            modTimeMillis: 1000,
            size: 7,
          }
          const source: SyncFolder = {
            type: 'local',
            appliesScanFilters: true,
            async *scan() {
              yield sourceFile
              throw new Error('scan boom')
            },
          }
          const dest = makeMemoryFolder([], 'b2')
          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'modtime', keepMode: 'delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: '',
          }

          await expect(collectEvents(config)).rejects.toThrow('scan boom')
          expect(mockBucket.upload).not.toHaveBeenCalled()
          expect(mockBucket.hideFile).not.toHaveBeenCalled()
          expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
          expect(mockBucket.copyFile).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )

    it('does not remove destination files after a source filesystem scan error', async () => {
      const mockBucket = makeMockBucket()
      const source: SyncFolder = {
        type: 'local',
        appliesScanFilters: true,
        appliesScanSorting: true,
        scan(filters) {
          filters?.onSkip?.({
            type: 'skip',
            path: 'blocked',
            size: 0,
            reason: 'filesystem-error',
            message: 'Skipped local path "blocked": permission denied',
          })
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<SyncPath>> {
                  return { done: true, value: undefined as never }
                },
              }
            },
          }
        },
      }
      const dest = makeMemoryFolder([makeB2SyncPath('blocked/file.txt', 1000, 4)], 'b2')
      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }
      const events: SyncEvent[] = []

      await expect(
        (async () => {
          for await (const event of synchronize(config)) {
            events.push(event)
          }
        })(),
      ).rejects.toThrow('permission denied')

      expect(events).toContainEqual(
        expect.objectContaining({ type: 'skip', reason: 'filesystem-error', path: 'blocked' }),
      )
      expect(mockBucket.hideFile).not.toHaveBeenCalled()
      expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
    })
  })

  describe('abort signal mid-flight', () => {
    it('drains a pending action when the async iterator is closed', async () => {
      const mockBucket = makeMockBucket()
      let finishCopy = () => {}
      const copyMayFinish = new Promise<void>((resolve) => {
        finishCopy = resolve
      })
      mockBucket.copyFile.mockImplementation(async () => {
        await copyMayFinish
      })

      const source = makeMemoryFolder(
        [makeB2SyncPath('a.txt', 1000, 1), makeB2SyncPath('b.txt', 1000, 1)],
        'b2',
      )
      const dest = makeMemoryFolder([], 'b2')
      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 2 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const iterator = synchronize(config)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'a.txt' },
      })
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'b.txt' },
      })
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)

      let returned = false
      const returnedPromise = iterator.return(undefined).then(() => {
        returned = true
      })
      await Promise.resolve()
      expect(returned).toBe(false)

      finishCopy()
      await returnedPromise
      expect(returned).toBe(true)
    })

    it('aborts a pending remote delete when the async iterator is closed', async () => {
      const mockBucket = makeMockBucket()
      const deleteStarted = deferred()
      let receivedSignal: AbortSignal | undefined
      mockBucket.deleteFileVersion.mockImplementation(
        async (_fileName: string, _fileId: string, options?: { readonly signal?: AbortSignal }) => {
          receivedSignal = options?.signal
          deleteStarted.resolve(undefined)
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      )

      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder(
        [makeB2SyncPath('a.txt', 1000, 1), makeB2SyncPath('b.txt', 1000, 1)],
        'b2',
      )
      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete', concurrency: 2 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const iterator = synchronize(config)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'a.txt' },
      })
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'b.txt' },
      })
      await deleteStarted.promise

      await iterator.return(undefined)

      expect(receivedSignal).toBeDefined()
      expect(receivedSignal?.aborted).toBe(true)
    })

    it('aborts a pending remote hide when the async iterator is closed', async () => {
      const mockBucket = makeMockBucket()
      const lockedBucket: typeof mockBucket & { info: object } = Object.assign(mockBucket, {
        info: {
          fileLockConfiguration: { value: { isFileLockEnabled: true } },
        },
      })
      const hideStarted = deferred()
      let receivedSignal: AbortSignal | undefined
      mockBucket.hideFile.mockImplementation(
        async (_fileName: string, options?: { readonly signal?: AbortSignal }) => {
          receivedSignal = options?.signal
          hideStarted.resolve(undefined)
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        },
      )

      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder(
        [makeB2SyncPath('a.txt', 1000, 1), makeB2SyncPath('b.txt', 1000, 1)],
        'b2',
      )
      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete', concurrency: 2 },
        bucket: lockedBucket as unknown as Bucket,
        prefix: '',
      }

      const iterator = synchronize(config)
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'a.txt' },
      })
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'compare', path: 'b.txt' },
      })
      await hideStarted.promise

      await iterator.return(undefined)

      expect(receivedSignal).toBeDefined()
      expect(receivedSignal?.aborted).toBe(true)
    })

    it('aborts sha1 sync before queuing a pair when signal flips during scan', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('cloud.txt', 1000, 10, undefined, 'a'.repeat(40))
      const source: SyncFolder = {
        type: 'b2',
        async *scan() {
          controller.abort()
          yield sourceFile
        },
      }
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', signal: controller.signal },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const events = await collectEvents(config)

      expect(events).toEqual([])
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('aborts sha1 sync after yielding a compare event from the final batch', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      const source = makeMemoryFolder(
        [makeB2SyncPath('cloud.txt', 1000, 10, undefined, 'a'.repeat(40))],
        'b2',
      )
      const dest = makeMemoryFolder(
        [makeB2SyncPath('cloud.txt', 1000, 10, undefined, 'b'.repeat(40))],
        'b2',
      )

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'sha1', keepMode: 'no-delete', signal: controller.signal },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const gen = synchronize(config)
      const first = await gen.next()
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('compare')

      controller.abort()
      const rest: SyncEvent[] = []
      while (true) {
        const next = await gen.next()
        if (next.done) break
        rest.push(next.value)
      }

      expect(rest).toEqual([])
      expect(mockBucket.copyFile).not.toHaveBeenCalled()
    })

    it('aborts before executing any action when signal flips during scan', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      // Many source files; abort fires after the first pair is yielded.
      const files = Array.from({ length: 8 }, (_, i) => makeLocalSyncPath(`file${i}.txt`, 1000, 10))
      const source: SyncFolder = {
        type: 'local',
        async *scan() {
          for (const f of files) {
            yield f
            // Trip the abort after yielding the first file so the next loop iteration short-circuits.
            controller.abort()
          }
        },
      }
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          signal: controller.signal,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      // The first pair generates one action, then abort fires; no execute should run.
      expect(mockBucket.upload).not.toHaveBeenCalled()
      // At most one compare event should escape (none if zipFolders is awaited before the next iter).
      const compares = events.filter((e) => e.type === 'compare')
      expect(compares.length).toBeLessThanOrEqual(1)
    })

    it('drains in-flight actions before returning when signal aborts during execution', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      const source = makeMemoryFolder(
        [makeB2SyncPath('first.txt', 1000, 10), makeB2SyncPath('second.txt', 1000, 10)],
        'b2',
      )
      const dest = makeMemoryFolder([], 'b2')
      let finishCopy = () => {}
      const copyMayFinish = new Promise<void>((resolve) => {
        finishCopy = resolve
      })
      mockBucket.copyFile.mockImplementation(async () => {
        controller.abort()
        await copyMayFinish
      })
      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', signal: controller.signal },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const run = collectEvents(config)
      let settled = false
      let events: SyncEvent[] = []
      let rejection: unknown
      const observed = run.then(
        (value) => {
          settled = true
          events = value
        },
        (err: unknown) => {
          settled = true
          rejection = err
        },
      )

      for (
        let attempts = 0;
        mockBucket.copyFile.mock.calls.length === 0 && attempts < 10;
        attempts++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(mockBucket.copyFile).toHaveBeenCalledTimes(1)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false)

      finishCopy()
      await observed
      expect(rejection).toBeUndefined()
      expect(events.some((event) => event.type === 'copy-done')).toBe(true)
    })

    it('skips action execution when signal aborts after scan completes', async () => {
      const controller = new AbortController()
      const mockBucket = makeMockBucket()
      const sourceFile = makeLocalSyncPath('late.txt', 1000, 10)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: {
          compareMode: 'modtime',
          keepMode: 'no-delete',
          signal: controller.signal,
        },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      // Kick off the generator, then abort before consuming events that would trigger execution.
      const gen = synchronize(config)
      // Pull the compare event first (scan stage).
      const first = await gen.next()
      expect(first.done).toBe(false)
      controller.abort()
      const rest: SyncEvent[] = []
      while (true) {
        const next = await gen.next()
        if (next.done) break
        rest.push(next.value)
      }
      expect(mockBucket.upload).not.toHaveBeenCalled()
      const uploads = rest.filter((e) => e.type === 'upload-done')
      expect(uploads).toHaveLength(0)
    })
  })

  describe('empty source and destination', () => {
    it('produces no events when both source and dest are empty', async () => {
      const mockBucket = makeMockBucket()
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events).toEqual([])
      expect(mockBucket.upload).not.toHaveBeenCalled()
    })
  })

  describe('concurrency limit', () => {
    it('throws for invalid concurrency values', async () => {
      const invalidValues = [0, -1, Number.NaN, 1.5]
      for (const concurrency of invalidValues) {
        const config: SynchronizerUpConfig = {
          source: { ...makeMemoryFolder([], 'local'), type: 'local', root: '/tmp' },
          dest: { ...makeMemoryFolder([], 'b2'), type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency },
          bucket: makeMockBucket() as unknown as Bucket,
          prefix: '',
        }

        await expect(collectEvents(config)).rejects.toThrow(
          'Sync concurrency must be a positive integer',
        )
      }
    })

    it('respects the configured concurrency limit (b2-to-b2 copy)', async () => {
      // Track simultaneous in-flight ops with an explicit gate.
      let inFlight = 0
      let maxInFlight = 0
      const mockBucket = makeMockBucket()
      mockBucket.copyFile = vi.fn().mockImplementation(async () => {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
      })

      const files = Array.from({ length: 6 }, (_, i) => makeB2SyncPath(`c${i}.txt`, 1000, 5))
      const source = makeMemoryFolder(files, 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 2 },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      const copies = events.filter((e) => e.type === 'copy-done')
      expect(copies).toHaveLength(6)
      expect(maxInFlight).toBeLessThanOrEqual(2)
      // With 6 actions and concurrency 2, at least 2 should overlap.
      expect(maxInFlight).toBeGreaterThanOrEqual(2)
    })
  })

  describe('factory bucket requirements', () => {
    it('throws when uploading without a bucket', async () => {
      const sourceFile = makeLocalSyncPath('x.txt', 1000, 10)
      const source = makeMemoryFolder([sourceFile], 'local')
      const dest = makeMemoryFolder([], 'b2')

      // Missing bucket triggers the factory's `throw new Error('Bucket required ...')`.
      const config = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        prefix: '',
      } as unknown as SynchronizerUpConfig

      await expect(collectEvents(config)).rejects.toThrow('Bucket required for upload actions')
    })

    it('throws when downloading without a bucket', async () => {
      const sourceFile = makeB2SyncPath('y.txt', 1000, 10)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'local')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'local', root: '/tmp' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
      } as unknown as SynchronizerDownConfig

      await expect(collectEvents(config)).rejects.toThrow('Bucket required for download actions')
    })

    it('throws when copying without a bucket', async () => {
      const sourceFile = makeB2SyncPath('z.txt', 1000, 10)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
      } as unknown as SynchronizerConfig

      await expect(collectEvents(config)).rejects.toThrow('Bucket required for copy actions')
    })

    it('throws when hiding without a bucket', async () => {
      const destFile = makeB2SyncPath('h.txt', 1000, 10)
      const source = makeMemoryFolder([], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        // local-to-b2 would use hide+deleteRemote on dest-only; we need a path where hide is invoked.
        // b2-to-b2 delete only emits deleteRemote, so use upload direction with no bucket.
        options: { compareMode: 'modtime', keepMode: 'delete' },
      } as unknown as SynchronizerConfig

      // For b2-to-b2 dest-only deletion, only `deleteRemote` factory runs (not hide),
      // and that itself throws the "Bucket required for delete actions" message.
      await expect(collectEvents(config)).rejects.toThrow('Bucket required for delete actions')
    })

    it('throws when removing an orphan in upload direction without a bucket', async () => {
      const destFile = makeB2SyncPath('h2.txt', 1000, 10)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        prefix: '',
      } as unknown as SynchronizerUpConfig

      // No bucket means `bucket?.info` is undefined → bucketIsLocked is
      // false → removeOrphan falls into `deleteRemote`, which then
      // throws via the assertBucket guard.
      await expect(collectEvents(config)).rejects.toThrow('Bucket required for delete actions')
    })
  })

  describe('upload direction execute (Node-only)', () => {
    it.skipIf(!isNode)('uploads a real local file to the mock bucket', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-'))
      try {
        const filePath = join(root, 'hello.txt')
        await writeFile(filePath, 'hello world')

        const mockBucket = makeMockBucket()
        const controller = new AbortController()
        const sourceFile: LocalSyncPath = {
          relativePath: 'hello.txt',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 11,
        }
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'modtime', keepMode: 'no-delete', signal: controller.signal },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'pfx\\nested',
        }

        const events = await collectEvents(config)
        const uploads = events.filter((e) => e.type === 'upload-done')
        expect(uploads).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
        const args = mockBucket.upload.mock.calls[0]?.[0] as Record<string, unknown> | undefined
        expect(args).toMatchObject({
          fileName: 'pfx\\nestedhello.txt',
          signal: controller.signal,
        })
        expect(args).not.toHaveProperty('serverSideEncryption')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('updates scanned slash-prefixed B2 keys by authoritative name', async () => {
      const { tmpdir } = await import('node:os')
      const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-raw-prefix-'))
      try {
        await mkdir(join(root, 'docs'), { recursive: true })
        const filePath = join(root, 'docs', 'readme.md')
        await writeFile(filePath, 'updated')

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'docs/readme.md',
          absolutePath: filePath,
          modTimeMillis: 2000,
          size: 7,
        }
        const destFile = makeB2SyncPath('docs/readme.md', 1000, 3, 'backup/docs/readme.md')
        const source = makeMemoryFolder([sourceFile], 'local')
        const dest = makeMemoryFolder([destFile], 'b2')

        const config: SynchronizerUpConfig = {
          source: { ...source, type: 'local', root },
          dest: { ...dest, type: 'b2' },
          options: { compareMode: 'size', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'backup',
        }

        await collectEvents(config)

        const args = mockBucket.upload.mock.calls[0]?.[0] as Record<string, unknown> | undefined
        expect(args).toMatchObject({ fileName: 'backup/docs/readme.md' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)(
      'refuses custom B2 destination keys outside the configured prefix',
      async () => {
        const { tmpdir } = await import('node:os')
        const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-up-prefix-escape-'))
        try {
          const filePath = join(root, 'report.txt')
          await writeFile(filePath, 'updated')

          const mockBucket = makeMockBucket()
          const sourceFile: LocalSyncPath = {
            relativePath: 'report.txt',
            absolutePath: filePath,
            modTimeMillis: 2000,
            size: 7,
          }
          const destFile = makeB2SyncPath('report.txt', 1000, 3, 'other-tenant/report.txt')
          const source = makeMemoryFolder([sourceFile], 'local')
          const dest = makeMemoryFolder([destFile], 'b2')

          const config: SynchronizerUpConfig = {
            source: { ...source, type: 'local', root },
            dest: { ...dest, type: 'b2' },
            options: { compareMode: 'size', keepMode: 'no-delete' },
            bucket: mockBucket as unknown as Bucket,
            prefix: 'tenant-a/',
          }

          const events = await collectEvents(config)

          expect(events).toContainEqual(
            expect.objectContaining({
              type: 'error',
              path: 'report.txt',
              message: 'Refusing to mutate B2 key outside configured prefix: report.txt',
            }),
          )
          expect(mockBucket.upload).not.toHaveBeenCalled()
          expect(mockBucket.hideFile).not.toHaveBeenCalled()
          expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
          expect(mockBucket.copyFile).not.toHaveBeenCalled()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    )
  })

  describe('upload prefix + orphan removal', () => {
    it('routes orphan removal through deleteFileVersion with the FULL B2 key on a vanilla bucket', async () => {
      // Vanilla bucket (no file-lock): the new policy yields a single
      // `removeOrphan` action that routes to `deleteFileVersion`. The
      // closure must call `deleteFileVersion` with the FULL B2 key
      // (prefix + relativePath), not the scanner-stripped relativePath.
      // Regression for an earlier bug where deleteRemote used
      // relativePath and silently failed with `file_not_present` on any
      // sync with a non-empty destination prefix.
      const mockBucket = makeMockBucket()
      const controller = new AbortController()
      // The scanner reports `relativePath: 'orphan.txt'` (prefix
      // stripped) but the FileVersion's `fileName` is the actual B2
      // key, `'backup/orphan.txt'`.
      const destFile = makeB2SyncPath('orphan.txt', 1000, 5, 'backup/orphan.txt')
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete', signal: controller.signal },
        bucket: mockBucket as unknown as Bucket,
        prefix: 'backup/',
      }

      const events = await collectEvents(config)
      const hides = events.filter((e) => e.type === 'hide')
      const deletes = events.filter((e) => e.type === 'delete-remote')
      expect(hides).toHaveLength(0)
      expect(deletes).toHaveLength(1)
      expect(mockBucket.hideFile).not.toHaveBeenCalled()
      expect(mockBucket.deleteFileVersion).toHaveBeenCalledTimes(1)
      // Crucial assertion: the actual B2 key is passed, NOT the
      // relativePath that the scanner reports.
      expect(mockBucket.deleteFileVersion).toHaveBeenCalledWith(
        'backup/orphan.txt',
        'fid_orphan.txt',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    it('routes orphan removal through hideFile (with prefix) on a file-lock-enabled bucket', async () => {
      // Locked bucket: `removeOrphan` picks `hide`, and the `HideAction`
      // closure uses the authoritative B2 key from the selected version.
      const mockBucket = makeMockBucket()
      const controller = new AbortController()
      const lockedBucket: typeof mockBucket & { info: object } = Object.assign(mockBucket, {
        info: {
          fileLockConfiguration: { value: { isFileLockEnabled: true } },
        },
      })
      const destFile = makeB2SyncPath('orphan.txt', 1000, 5, 'backup/orphan.txt')
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete', signal: controller.signal },
        bucket: lockedBucket as unknown as Bucket,
        prefix: 'backup',
      }

      const events = await collectEvents(config)
      const hides = events.filter((e) => e.type === 'hide')
      const deletes = events.filter((e) => e.type === 'delete-remote')
      expect(hides).toHaveLength(1)
      expect(deletes).toHaveLength(0)
      expect(mockBucket.hideFile).toHaveBeenCalledWith(
        'backup/orphan.txt',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
    })
  })
})
