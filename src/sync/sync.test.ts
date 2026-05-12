import { describe, expect, it } from 'vitest'
import type { FileVersion } from '../types/file.js'
import type { AccountId, BucketId, FileId } from '../types/ids.js'
import { SkipAction, UploadAction } from './actions/index.js'
import { zipFolders } from './pairing.js'
import { filesAreDifferent } from './policies/compare.js'
import { generateActions } from './policies/index.js'
import type { ActionFactory } from './policies/index.js'
import type { B2SyncPath, LocalSyncPath, SyncFolder, SyncPath } from './types.js'

function makeSyncPath(relativePath: string, modTimeMillis: number, size: number): SyncPath {
  return { relativePath, modTimeMillis, size }
}

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

function makeMemoryFolder(files: SyncPath[]): SyncFolder {
  return {
    type: 'local',
    async *scan() {
      const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      for (const f of sorted) yield f
    },
  }
}

function makeNoopFactory(): ActionFactory {
  return {
    upload: (s: LocalSyncPath) =>
      new UploadAction(s.relativePath, s.absolutePath, s.size, async () => {}),
    download: (s: B2SyncPath) => new SkipAction(s.relativePath, 'noop-download'),
    copy: (s: B2SyncPath, _dest: string) => new SkipAction(s.relativePath, 'noop-copy'),
    hide: (path: string) => new SkipAction(path, 'noop-hide'),
    deleteRemote: (s: B2SyncPath) => new SkipAction(s.relativePath, 'noop-delete-remote'),
    deleteLocal: (s: LocalSyncPath) => new SkipAction(s.relativePath, 'noop-delete-local'),
  }
}

describe('filesAreDifferent', () => {
  const a = makeSyncPath('file.txt', 1000, 100)
  const b = makeSyncPath('file.txt', 1000, 100)

  it('returns false when files are identical (modtime)', () => {
    expect(filesAreDifferent(a, b, 'modtime')).toBe(false)
  })

  it('returns true when modtime differs', () => {
    const newer = makeSyncPath('file.txt', 2000, 100)
    expect(filesAreDifferent(a, newer, 'modtime')).toBe(true)
  })

  it('returns false when modtime within threshold', () => {
    const close = makeSyncPath('file.txt', 1500, 100)
    expect(filesAreDifferent(a, close, 'modtime', 1000)).toBe(false)
  })

  it('returns true when size differs', () => {
    const bigger = makeSyncPath('file.txt', 1000, 200)
    expect(filesAreDifferent(a, bigger, 'size')).toBe(true)
  })

  it('returns false in none mode', () => {
    const different = makeSyncPath('file.txt', 9999, 999)
    expect(filesAreDifferent(a, different, 'none')).toBe(false)
  })
})

describe('zipFolders', () => {
  it('pairs matching files from both folders', async () => {
    const source = makeMemoryFolder([
      makeSyncPath('a.txt', 1000, 10),
      makeSyncPath('b.txt', 1000, 20),
    ])
    const dest = makeMemoryFolder([
      makeSyncPath('a.txt', 1000, 10),
      makeSyncPath('c.txt', 1000, 30),
    ])

    const pairs: Array<[string | null, string | null]> = []
    for await (const [s, d] of zipFolders(source, dest)) {
      pairs.push([s?.relativePath ?? null, d?.relativePath ?? null])
    }

    expect(pairs).toEqual([
      ['a.txt', 'a.txt'],
      ['b.txt', null],
      [null, 'c.txt'],
    ])
  })

  it('handles empty source', async () => {
    const source = makeMemoryFolder([])
    const dest = makeMemoryFolder([makeSyncPath('x.txt', 1000, 10)])

    const pairs: Array<[string | null, string | null]> = []
    for await (const [s, d] of zipFolders(source, dest)) {
      pairs.push([s?.relativePath ?? null, d?.relativePath ?? null])
    }

    expect(pairs).toEqual([[null, 'x.txt']])
  })

  it('handles empty dest', async () => {
    const source = makeMemoryFolder([makeSyncPath('y.txt', 1000, 10)])
    const dest = makeMemoryFolder([])

    const pairs: Array<[string | null, string | null]> = []
    for await (const [s, d] of zipFolders(source, dest)) {
      pairs.push([s?.relativePath ?? null, d?.relativePath ?? null])
    }

    expect(pairs).toEqual([['y.txt', null]])
  })

  it('handles both empty', async () => {
    const pairs: Array<[string | null, string | null]> = []
    for await (const [s, d] of zipFolders(makeMemoryFolder([]), makeMemoryFolder([]))) {
      pairs.push([s?.relativePath ?? null, d?.relativePath ?? null])
    }
    expect(pairs).toEqual([])
  })
})

describe('generateActions', () => {
  const factory = makeNoopFactory()
  const now = Date.now()

  it('generates upload for source-only file (local-to-b2)', () => {
    const source = makeLocalSyncPath('new.txt', now, 100)
    const actions = [
      ...generateActions([source, null], 'local-to-b2', 'modtime', 'no-delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('upload')
  })

  it('generates skip for dest-only file with no-delete', () => {
    const dest = makeB2SyncPath('old.txt', now, 50)
    const actions = [
      ...generateActions([null, dest], 'local-to-b2', 'modtime', 'no-delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('skip')
  })

  it('generates hide+delete for dest-only file with delete mode', () => {
    const dest = makeB2SyncPath('gone.txt', now, 50)
    const actions = [
      ...generateActions([null, dest], 'local-to-b2', 'modtime', 'delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(2)
    expect(actions[0]?.type).toBe('skip')
    expect(actions[1]?.type).toBe('skip')
  })

  it('generates skip when files are the same', () => {
    const source = makeLocalSyncPath('same.txt', 1000, 100)
    const dest = makeB2SyncPath('same.txt', 1000, 100)
    const actions = [
      ...generateActions([source, dest], 'local-to-b2', 'modtime', 'no-delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('skip')
    expect((actions[0] as SkipAction).reason).toBe('files are the same')
  })

  it('generates upload when files differ', () => {
    const source = makeLocalSyncPath('changed.txt', 2000, 200)
    const dest = makeB2SyncPath('changed.txt', 1000, 100)
    const actions = [
      ...generateActions([source, dest], 'local-to-b2', 'modtime', 'no-delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('upload')
  })

  it('respects keep-days for recent files', () => {
    const recentTime = now - 12 * 60 * 60 * 1000
    const dest = makeB2SyncPath('recent.txt', recentTime, 50)
    const actions = [
      ...generateActions([null, dest], 'local-to-b2', 'modtime', 'keep-days', 7, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('skip')
  })
})
