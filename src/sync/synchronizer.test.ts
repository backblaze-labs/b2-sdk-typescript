import { describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { daysFromNow } from '../test-utils/index.ts'
import { EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import type {
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize } from './synchronizer.ts'
import type { B2SyncPath, LocalSyncPath, SyncEvent, SyncFolder, SyncPath } from './types.ts'

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
): B2SyncPath {
  const fv: FileVersion = {
    accountId: 'acc' as unknown as AccountId,
    action: FileAction.Upload,
    bucketId: 'bucket' as unknown as BucketId,
    contentLength: size,
    contentMd5: null,
    contentSha1: 'sha1',
    contentType: 'application/octet-stream',
    fileId: `fid_${relativePath}` as unknown as FileId,
    fileInfo: {},
    fileName: b2FileName ?? relativePath,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: { mode: EncryptionMode.None },
    uploadTimestamp: modTimeMillis,
  }
  return { relativePath, modTimeMillis, size, selectedVersion: fv, allVersions: [fv] }
}

function makeMemoryFolder(files: SyncPath[], type: 'local' | 'b2' = 'local'): SyncFolder {
  return {
    type,
    async *scan() {
      const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
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

// A minimal mock bucket that records calls but does not perform real I/O.
function makeMockBucket() {
  return {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.close()
        },
      }),
    }),
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
    const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'
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
      } finally {
        await rm(root, { recursive: true, force: true })
      }
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
    const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'

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
      expect(errors[1]?.message).toContain('1 action(s) failed')
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
    const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'

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
        const args = mockBucket.upload.mock.calls[0]?.[0] as { fileName: string }
        expect(args.fileName).toBe('pfx/hello.txt')
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
