import { describe, expect, it } from 'vitest'
import { EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { SkipAction, UploadAction } from './actions/index.ts'
import { zipFolders } from './pairing.ts'
import {
  filesAreDifferent,
  preparePairForCompare,
  preparePairsForCompare,
  selectB2ComparableSha1,
} from './policies/compare.ts'
import type { ActionFactory } from './policies/index.ts'
import { generateActions } from './policies/index.ts'
import type { B2SyncPath, LocalSyncPath, SyncFolder, SyncPath } from './types.ts'

function makeSyncPath(
  relativePath: string,
  modTimeMillis: number,
  size: number,
  contentSha1?: string | null,
): SyncPath {
  return {
    relativePath,
    modTimeMillis,
    size,
    ...(contentSha1 !== undefined ? { contentSha1 } : {}),
  }
}

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
    fileName: relativePath,
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

function withoutPathContentSha1(path: B2SyncPath): B2SyncPath {
  return {
    relativePath: path.relativePath,
    modTimeMillis: path.modTimeMillis,
    size: path.size,
    selectedVersion: path.selectedVersion,
    allVersions: path.allVersions,
  }
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
    // For the noop test factory, treat orphans as the equivalent of
    // `deleteRemote` regardless of bucket state — the production
    // synchronizer factory is the one that branches on lock state.
    removeOrphan: (s: B2SyncPath) => new SkipAction(s.relativePath, 'noop-remove-orphan'),
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

  it('returns false when sha1 values match', () => {
    const sha1 = 'a'.repeat(40)
    const source = makeSyncPath('file.txt', 1000, 100, sha1)
    const dest = makeSyncPath('file.txt', 2000, 100, sha1.toUpperCase())
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(false)
  })

  it('returns true when sha1 values differ', () => {
    const source = makeSyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const dest = makeSyncPath('file.txt', 1000, 100, 'b'.repeat(40))
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('returns true when size differs in sha1 mode', () => {
    const source = makeSyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const dest = makeSyncPath('file.txt', 1000, 200, 'a'.repeat(40))
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('returns true in sha1 mode when either hash is unavailable', () => {
    const source = makeSyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const dest = makeSyncPath('file.txt', 1000, 100, null)
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('returns true in sha1 mode for unverified B2 checksum sentinels', () => {
    const sha1 = 'a'.repeat(40)
    const source = makeSyncPath('file.txt', 1000, 100, sha1)
    const dest = makeSyncPath('file.txt', 1000, 100, `unverified:${sha1}`)
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('returns true in sha1 mode for present but invalid checksum metadata', () => {
    const source = makeSyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const dest = makeSyncPath('file.txt', 1000, 100, 'not-a-sha1')
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('treats a B2 path with explicit null contentSha1 as unavailable', () => {
    const sha1 = 'a'.repeat(40)
    const source = makeSyncPath('file.txt', 1000, 100, sha1)
    const dest = makeB2SyncPath('file.txt', 1000, 100, sha1, {}, null)
    expect(filesAreDifferent(source, dest, 'sha1')).toBe(true)
  })

  it('returns false in none mode', () => {
    const different = makeSyncPath('file.txt', 9999, 999)
    expect(filesAreDifferent(a, different, 'none')).toBe(false)
  })

  it('throws for an unsupported compare mode', () => {
    expect(() => filesAreDifferent(a, b, 'sha256' as never)).toThrow('Unsupported compare mode')
  })
})

describe('selectB2ComparableSha1', () => {
  it('uses fileInfo.large_file_sha1 when contentSha1 is unavailable', () => {
    const sha1 = 'a'.repeat(40)
    const file = makeB2SyncPath('large.bin', 1000, 100, null, {
      large_file_sha1: sha1.toUpperCase(),
    })
    expect(selectB2ComparableSha1(file.selectedVersion)).toBe(sha1)
  })

  it('preserves unverified sentinels as untrusted metadata', () => {
    const sha1 = 'a'.repeat(40)
    const file = makeB2SyncPath('untrusted.txt', 1000, 100, `unverified:${sha1}`)
    expect(selectB2ComparableSha1(file.selectedVersion)).toBe(`unverified:${sha1}`)
  })
})

describe('preparePairForCompare', () => {
  it('skips local hashing when size already proves a sha1 difference', async () => {
    const source = makeLocalSyncPath('file.txt', 1000, 100)
    const dest = makeB2SyncPath('file.txt', 1000, 200, 'a'.repeat(40))
    const readLocalSha1 = async () => {
      throw new Error('should not hash')
    }

    const result = await preparePairForCompare([source, dest], 'sha1', { readLocalSha1 })

    expect(result.bytesHashed).toBe(0)
    expect(result.skipActionGeneration).toBe(false)
  })

  it('returns an error event when local sha1 hashing fails', async () => {
    const source = makeLocalSyncPath('file.txt', 1000, 100)
    const dest = makeB2SyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const result = await preparePairForCompare([source, dest], 'sha1', {
      readLocalSha1: async () => {
        throw Object.assign(new Error("ENOENT: open '/tmp/file.txt'"), { code: 'ENOENT' })
      },
    })

    expect(result.skipActionGeneration).toBe(true)
    expect(result.events[0]).toMatchObject({
      type: 'error',
      path: 'file.txt',
      message: 'failed to hash local file for sha1 comparison: ENOENT',
    })
    const event = result.events[0]
    expect(event?.type).toBe('error')
    if (event?.type !== 'error') throw new Error('expected error event')
    expect(event.message).not.toContain('/tmp/file.txt')
    expect(result.errors).toHaveLength(1)
  })

  it('surfaces safe local sha1 error messages', async () => {
    const source = makeLocalSyncPath('file.txt', 1000, 100)
    const dest = makeB2SyncPath('file.txt', 1000, 100, 'a'.repeat(40))
    const result = await preparePairForCompare([source, dest], 'sha1', {
      readLocalSha1: async () => {
        throw new Error('not a regular file')
      },
    })

    expect(result.events[0]).toMatchObject({
      type: 'error',
      path: 'file.txt',
      message: 'failed to hash local file for sha1 comparison: not a regular file',
    })
  })

  it('keeps prepared B2 sha1 metadata when local hashing fails', async () => {
    const sha1 = 'a'.repeat(40)
    const source = makeLocalSyncPath('large.bin', 1000, 100)
    const dest = withoutPathContentSha1(makeB2SyncPath('large.bin', 1000, 100, sha1))

    const result = await preparePairForCompare([source, dest], 'sha1', {
      readLocalSha1: async () => {
        throw new Error('read failed')
      },
    })

    expect(result.skipActionGeneration).toBe(true)
    expect(result.pair[1]?.contentSha1).toBe(sha1)
  })

  it('does not skip action generation for invalid B2 checksum metadata', async () => {
    const source = makeLocalSyncPath('file.txt', 1000, 100)
    const dest = makeB2SyncPath('file.txt', 1000, 100, 'not-a-sha1')

    const result = await preparePairForCompare([source, dest], 'sha1', {
      readLocalSha1: async () => {
        throw new Error('should not hash')
      },
    })

    expect(result.skipActionGeneration).toBe(false)
    expect(result.events).toEqual([])
  })

  it('returns aborted when local sha1 hashing observes an abort signal', async () => {
    const controller = new AbortController()
    const sha1 = 'a'.repeat(40)
    const source = makeLocalSyncPath('file.txt', 1000, 100)
    const dest = withoutPathContentSha1(makeB2SyncPath('file.txt', 1000, 100, sha1))

    const result = await preparePairForCompare([source, dest], 'sha1', {
      signal: controller.signal,
      readLocalSha1: async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    })

    expect(result.aborted).toBe(true)
    expect(result.events).toEqual([])
    expect(result.pair[1]?.contentSha1).toBe(sha1)
  })
})

describe('preparePairsForCompare', () => {
  it('prepares sha1 pairs with bounded concurrency', async () => {
    const sha1 = 'a'.repeat(40)
    const pairs = [1, 2, 3].map((n): [LocalSyncPath, B2SyncPath] => [
      makeLocalSyncPath(`file-${n}.txt`, 1000, 100),
      makeB2SyncPath(`file-${n}.txt`, 1000, 100, 'b'.repeat(40)),
    ])
    let active = 0
    let maxActive = 0
    const releaseQueue: Array<() => void> = []

    const promise = preparePairsForCompare(pairs, 'sha1', {
      concurrency: 2,
      readLocalSha1: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise<void>((resolve) => releaseQueue.push(resolve))
        active -= 1
        return sha1
      },
    })

    while (releaseQueue.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(active).toBe(2)
    releaseQueue.shift()?.()

    while (releaseQueue.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    for (const release of releaseQueue.splice(0)) release()

    const results = await promise
    expect(results).toHaveLength(3)
    expect(maxActive).toBe(2)
  })

  it('returns aborted results for every pair when preparation aborts early', async () => {
    const controller = new AbortController()
    controller.abort()
    const pairs = [1, 2, 3].map((n): [LocalSyncPath, B2SyncPath] => [
      makeLocalSyncPath(`file-${n}.txt`, 1000, 100),
      makeB2SyncPath(`file-${n}.txt`, 1000, 100, 'b'.repeat(40)),
    ])

    const results = await preparePairsForCompare(pairs, 'sha1', { signal: controller.signal })

    expect(results).toHaveLength(pairs.length)
    expect(results.map((result) => result.originalPair[0]?.relativePath)).toEqual(
      pairs.map((pair) => pair[0].relativePath),
    )
    expect(results.every((result) => result.prepared.aborted)).toBe(true)
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

  it('yields dest-only when dest file sorts before source file', async () => {
    const source = makeMemoryFolder([makeSyncPath('c.txt', 1000, 10)])
    const dest = makeMemoryFolder([
      makeSyncPath('a.txt', 1000, 20),
      makeSyncPath('b.txt', 1000, 30),
      makeSyncPath('c.txt', 1000, 10),
    ])

    const pairs: Array<[string | null, string | null]> = []
    for await (const [s, d] of zipFolders(source, dest)) {
      pairs.push([s?.relativePath ?? null, d?.relativePath ?? null])
    }

    expect(pairs).toEqual([
      [null, 'a.txt'],
      [null, 'b.txt'],
      ['c.txt', 'c.txt'],
    ])
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

  it('generates one orphan-removal action for dest-only file with delete mode', () => {
    // Policy now yields a single `removeOrphan` action per dest-only
    // file in delete mode (previously it yielded both hide AND
    // deleteRemote unconditionally, which stacked hide markers on
    // vanilla buckets even though the delete that followed made them
    // redundant). The factory picks hide-vs-delete based on the bucket's
    // file-lock state — irrelevant in this generator-policy test, which
    // uses a noop factory.
    const dest = makeB2SyncPath('gone.txt', now, 50)
    const actions = [
      ...generateActions([null, dest], 'local-to-b2', 'modtime', 'delete', 0, now, factory, 0),
    ]
    expect(actions).toHaveLength(1)
    expect(actions[0]?.type).toBe('skip')
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
