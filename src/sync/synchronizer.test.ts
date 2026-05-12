import { describe, expect, it, vi } from 'vitest'
import type { FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { synchronize } from './synchronizer.ts'
import type {
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
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

function makeB2SyncPath(relativePath: string, modTimeMillis: number, size: number): B2SyncPath {
  const fv: FileVersion = {
    accountId: 'acc' as unknown as AccountId,
    action: 'upload',
    bucketId: 'bucket' as unknown as BucketId,
    contentLength: size,
    contentMd5: null,
    contentSha1: 'sha1',
    contentType: 'application/octet-stream',
    fileId: `fid_${relativePath}` as unknown as FileId,
    fileInfo: {},
    fileName: relativePath,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: { mode: 'none' },
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
        bucket: makeMockBucket() as any,
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
        bucket: makeMockBucket() as any,
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
        bucket: makeMockBucket() as any,
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
        bucket: makeMockBucket() as any,
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
        bucket: makeMockBucket() as any,
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
        bucket: mockBucket as any,
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
        bucket: mockBucket as any,
        prefix: '',
      }

      const events = await collectEvents(config)
      // With delete mode, dest-only files get hide + deleteRemote actions.
      // In dry-run, the bucket methods should not be called.
      expect(mockBucket.hideFile).not.toHaveBeenCalled()
      expect(mockBucket.deleteFileVersion).not.toHaveBeenCalled()
      // But we should still see the events produced
      const nonCompare = events.filter((e) => e.type !== 'compare')
      expect(nonCompare.length).toBeGreaterThanOrEqual(2)
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
        bucket: makeMockBucket() as any,
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
        bucket: mockBucket as any,
        prefix: '',
      }

      const events = await collectEvents(config)
      // For local-to-b2 delete mode, policy yields hide + deleteRemote
      const hideEvents = events.filter((e) => e.type === 'hide')
      const deleteEvents = events.filter((e) => e.type === 'delete-remote')
      expect(hideEvents).toHaveLength(1)
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
        bucket: makeMockBucket() as any,
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
        bucket: makeMockBucket() as any,
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
          bucket: mockBucket as any,
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
})
