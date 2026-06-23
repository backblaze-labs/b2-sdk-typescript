import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha1Hex } from '../streams/hash.ts'
import { EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { readLocalSha1File } from './local-sha1.ts'
import { preparePairForCompare } from './policies/compare.ts'
import type { B2SyncPath, LocalSyncPath } from './types.ts'

function makeLocalSyncPath(
  relativePath: string,
  absolutePath: string,
  size: number,
): LocalSyncPath {
  return { relativePath, absolutePath, modTimeMillis: 1000, size }
}

function makeB2SyncPath(relativePath: string, size: number, contentSha1: string): B2SyncPath {
  const version: FileVersion = {
    accountId: 'acc' as unknown as AccountId,
    action: FileAction.Upload,
    bucketId: 'bucket' as unknown as BucketId,
    contentLength: size,
    contentMd5: null,
    contentSha1,
    contentType: 'application/octet-stream',
    fileId: `fid_${relativePath}` as unknown as FileId,
    fileInfo: {},
    fileName: relativePath,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: { mode: EncryptionMode.None },
    uploadTimestamp: 1000,
  }
  return {
    relativePath,
    modTimeMillis: 1000,
    size,
    contentSha1,
    selectedVersion: version,
    allVersions: [version],
  }
}

describe('preparePairForCompare default local SHA-1 reader', () => {
  it('hashes zero-byte local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-empty-'))
    try {
      const filePath = join(root, 'empty.txt')
      await writeFile(filePath, '')

      const digest = await sha1Hex(new Uint8Array())
      const source = makeLocalSyncPath('empty.txt', filePath, 0)
      const dest = makeB2SyncPath('empty.txt', 0, digest)

      const result = await preparePairForCompare([source, dest], 'sha1', {
        readLocalSha1: readLocalSha1File,
      })

      expect(result.skipActionGeneration).toBe(false)
      expect(result.bytesHashed).toBe(0)
      expect(result.pair[0]?.contentSha1).toBe(digest)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces directories as per-file hash errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-directory-'))
    try {
      const directoryPath = join(root, 'directory')
      await mkdir(directoryPath)

      const source = makeLocalSyncPath('directory', directoryPath, 0)
      const dest = makeB2SyncPath('directory', 0, 'a'.repeat(40))

      const result = await preparePairForCompare([source, dest], 'sha1', {
        readLocalSha1: readLocalSha1File,
      })

      expect(result.skipActionGeneration).toBe(true)
      expect(result.events[0]).toMatchObject({
        type: 'error',
        path: 'directory',
        message:
          'failed to hash local file for sha1 comparison: local file changed before sha1 comparison: not a regular file',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces scanned-size drift as a per-file hash error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-sha1-size-drift-'))
    try {
      const filePath = join(root, 'changed.txt')
      await writeFile(filePath, 'abcd')

      const source = makeLocalSyncPath('changed.txt', filePath, 3)
      const dest = makeB2SyncPath('changed.txt', 3, 'a'.repeat(40))

      const result = await preparePairForCompare([source, dest], 'sha1', {
        readLocalSha1: readLocalSha1File,
      })

      expect(result.skipActionGeneration).toBe(true)
      expect(result.events[0]).toMatchObject({
        type: 'error',
        path: 'changed.txt',
        message:
          'failed to hash local file for sha1 comparison: local file changed before sha1 comparison: size changed',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
