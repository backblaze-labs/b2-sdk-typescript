import { describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { sha1Hex } from '../streams/hash.ts'
import { daysFromNow } from '../test-utils/index.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { compareSyncPathNames } from './path-order.ts'
import type {
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize } from './synchronizer.ts'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncEncryptionProvider,
  SyncEvent,
  SyncFolder,
  SyncPath,
  SyncScanOptions,
} from './types.ts'

const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'
const processLike = (globalThis as { process?: { platform?: string } }).process
const isWindows = processLike?.platform === 'win32'

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
    async *scan() {
      const sorted = [...files].sort((a, b) => compareSyncPathNames(a.relativePath, b.relativePath))
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

function streamFromBytes(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data)
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

    it('reports completed actions when a later scan error aborts the sync', async () => {
      const sourceFile = makeLocalSyncPath('uploaded.txt', 2000, 50)
      const source: SyncFolder = {
        type: 'local',
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
        bucket: makeMockBucket() as unknown as Bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      const uploadIndex = events.findIndex((event) => event.type === 'upload-done')
      const scanErrorIndex = events.findIndex(
        (event) => event.type === 'error' && event.path === 'later.txt',
      )
      const summaryIndex = events.findIndex((event) => event.type === 'error' && event.path === '')

      expect(events[0]).toMatchObject({ type: 'compare', path: 'uploaded.txt' })
      expect(uploadIndex).toBeGreaterThan(0)
      expect(scanErrorIndex).toBeGreaterThan(uploadIndex)
      expect(summaryIndex).toBeGreaterThan(scanErrorIndex)
    })

    it('drains in-flight actions before rethrowing scan errors without diagnostics', async () => {
      const sourceFile = makeB2SyncPath('copied.txt', 2000, 50)
      const source: SyncFolder = {
        type: 'b2',
        async *scan() {
          yield sourceFile
          throw new Error('scan exploded')
        },
      }
      const dest = makeMemoryFolder([], 'b2')
      const mockBucket = makeMockBucket()
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
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: 4 },
        bucket: mockBucket as unknown as Bucket,
      } satisfies SynchronizerConfig & { readonly bucket: Bucket }

      const run = collectEvents(config)
      let settled = false
      let rejection: unknown
      const observed = run.then(
        () => {
          settled = true
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
      expect(rejection).toBeInstanceOf(Error)
      expect((rejection as Error).message).toBe('scan exploded')
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
  })

  describe('download direction actions', () => {
    // Skipped in browsers: the download action writes to local disk via
    // `node:fs/promises`, which is unavailable in non-Node runtimes.
    it.skipIf(!isNode)('executes download for source-only B2 file', async () => {
      // Use a portable per-OS tmpdir so this test passes on Windows (where
      // `/tmp/dest` would resolve to `C:\tmp\dest` and likely fail to create).
      const { tmpdir } = await import('node:os')
      const { mkdtemp, rm } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-'))
      try {
        const mockBucket = makeMockBucket()
        const sourceFile = makeB2SyncPath('remote.txt', 2000, 200)
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
        expect(mockBucket.download).toHaveBeenCalledWith('remote.txt', {})
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
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
          // Deliberately stale to verify the provider sees the bytes actually read.
          size: 999,
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
        expect(mockBucket.download).toHaveBeenCalledWith('secret.txt', {
          serverSideEncryption: sourceSse,
        })
        expect(mockBucket.download.mock.calls[0]?.[1]?.serverSideEncryption).toBe(sourceSse)
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
        expect(mockBucket.download).toHaveBeenCalledWith('b2-managed.txt', {})
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
      expect(mockBucket.copyFile).toHaveBeenCalledWith({
        sourceFileId: sourceFile.selectedVersion.fileId,
        fileName: 'copy.txt',
        destinationServerSideEncryption: destinationSse,
        sourceServerSideEncryption: sourceSse,
      })
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
        expect(mockBucket.downloadById).toHaveBeenCalledWith('fid_stable.txt', {})
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
        expect(mockBucket.downloadById).toHaveBeenCalledWith('fid_large.bin', {})
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

    it.skipIf(!isNode)('surfaces errors while verifying matching B2 metadata bytes', async () => {
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
        expect(errors[0]?.path).toBe('remote-read-error.txt')
        expect(errors[0]?.message).toContain('failed to hash B2 file')
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
      expect(errors[0]?.path).toBe('remote-stall.txt')
      expect(errors[0]?.message).toContain('sha1 B2 read stalled')
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

    it.skipIf(!isNode)('hashes local files even when a scanner supplies contentSha1', async () => {
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
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
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
      expect(events.find((e) => e.type === 'compare')?.bytesHashed).toBe(0)
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
        const compare = events.find((e) => e.type === 'compare')
        expect(compare?.size).toBe(0)
        expect(compare?.bytesHashed).toBe(data.byteLength)
        expect(events.filter((e) => e.type === 'upload-done')).toHaveLength(1)
        expect(mockBucket.upload).not.toHaveBeenCalled()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.skipIf(!isNode)('prepares sha1 comparisons in bounded batches', async () => {
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
        expect(sourceScans).toBe(2)
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
        const filePath = join(root, 'large.bin')
        const file = await open(filePath, 'w')
        await file.truncate(512 * 1024 * 1024)
        await file.close()

        const mockBucket = makeMockBucket()
        const sourceFile: LocalSyncPath = {
          relativePath: 'large.bin',
          absolutePath: filePath,
          modTimeMillis: 1000,
          size: 512 * 1024 * 1024,
        }
        const destFile = makeB2SyncPath(
          'large.bin',
          1000,
          512 * 1024 * 1024,
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
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-down-'))
      try {
        const localPath = join(root, 'remote.txt')
        await writeFile(localPath, 'xyz')

        const mockBucket = makeMockBucket()
        const remoteData = new TextEncoder().encode('abc')
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
        expect(mockBucket.download).toHaveBeenCalledTimes(1)
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

    it('copies a paired-but-different file in b2-to-b2 mode', async () => {
      const mockBucket = makeMockBucket()
      const sourceFile = makeB2SyncPath('paired.txt', 5000, 100)
      const destFile = makeB2SyncPath('paired.txt', 1000, 100)
      const source = makeMemoryFolder([sourceFile], 'b2')
      const dest = makeMemoryFolder([destFile], 'b2')

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
      expect(mockBucket.copyFile).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'paired.txt' }),
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
  })

  describe('abort signal mid-flight', () => {
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

    it('normalizes invalid concurrency before transfer execution', async () => {
      const mockBucket = makeMockBucket()
      const source = makeMemoryFolder([makeB2SyncPath('copy.txt', 1000, 5)], 'b2')
      const dest = makeMemoryFolder([], 'b2')

      const config = {
        source: { ...source, type: 'b2' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'no-delete', concurrency: Number.NaN },
        bucket: mockBucket as unknown as Bucket,
        prefix: '',
      } as unknown as SynchronizerUpConfig

      const events = await collectEvents(config)
      expect(events.filter((e) => e.type === 'copy-done')).toHaveLength(1)
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
          options: { compareMode: 'modtime', keepMode: 'no-delete' },
          bucket: mockBucket as unknown as Bucket,
          prefix: 'pfx/',
        }

        const events = await collectEvents(config)
        const uploads = events.filter((e) => e.type === 'upload-done')
        expect(uploads).toHaveLength(1)
        expect(mockBucket.upload).toHaveBeenCalledTimes(1)
        const args = mockBucket.upload.mock.calls[0]?.[0] as Record<string, unknown> | undefined
        expect(args).toMatchObject({ fileName: 'pfx/hello.txt' })
        expect(args).not.toHaveProperty('serverSideEncryption')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
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
      // The scanner reports `relativePath: 'orphan.txt'` (prefix
      // stripped) but the FileVersion's `fileName` is the actual B2
      // key, `'backup/orphan.txt'`.
      const destFile = makeB2SyncPath('orphan.txt', 1000, 5, 'backup/orphan.txt')
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
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
      )
    })

    it('routes orphan removal through hideFile (with prefix) on a file-lock-enabled bucket', async () => {
      // Locked bucket: `removeOrphan` picks `hide`, and the `HideAction`
      // closure prepends the configured prefix to the file name before
      // calling `bucket.hideFile`. This preserves the old prefix
      // behaviour for the cases where it actually matters.
      const mockBucket = makeMockBucket()
      const lockedBucket: typeof mockBucket & { info: object } = Object.assign(mockBucket, {
        info: {
          fileLockConfiguration: { value: { isFileLockEnabled: true } },
        },
      })
      const destFile = makeB2SyncPath('orphan.txt', 1000, 5)
      const source = makeMemoryFolder([], 'local')
      const dest = makeMemoryFolder([destFile], 'b2')

      const config: SynchronizerUpConfig = {
        source: { ...source, type: 'local', root: '/tmp' },
        dest: { ...dest, type: 'b2' },
        options: { compareMode: 'modtime', keepMode: 'delete' },
        bucket: lockedBucket as unknown as Bucket,
        prefix: 'backup/',
      }

      const events = await collectEvents(config)
      const hides = events.filter((e) => e.type === 'hide')
      const deletes = events.filter((e) => e.type === 'delete-remote')
      expect(hides).toHaveLength(1)
      expect(deletes).toHaveLength(0)
      expect(mockBucket.hideFile).toHaveBeenCalledWith('backup/orphan.txt')
      expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
    })
  })
})
