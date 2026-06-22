import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readScannedLocalFile,
  writeLocalFileInsideRoot,
  writeLocalStreamInsideRoot,
} from './local-file-io.ts'
import type { LocalSyncPath } from './types.ts'

const textEncoder = new TextEncoder()

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function makeScannedPath(root: string, name: string, data: string): Promise<LocalSyncPath> {
  const absolutePath = join(root, name)
  const bytes = textEncoder.encode(data)
  await writeFile(absolutePath, bytes)
  const stats = await stat(absolutePath)
  return {
    relativePath: name,
    absolutePath,
    modTimeMillis: Math.floor(stats.mtimeMs),
    size: bytes.byteLength,
    fileIdentity: {
      deviceId: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modTimeMillis: Math.floor(stats.mtimeMs),
    },
  }
}

describe('readScannedLocalFile', () => {
  it('reads a scanned regular file when identity still matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-read-'))
    try {
      const path = await makeScannedPath(root, 'file.txt', 'abc')

      await expect(readScannedLocalFile(path)).resolves.toEqual(textEncoder.encode('abc'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a scanned file whose identity changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-identity-'))
    try {
      const path = await makeScannedPath(root, 'file.txt', 'abc')
      const identity = path.fileIdentity
      expect(identity).toBeDefined()

      await expect(
        readScannedLocalFile({
          ...path,
          fileIdentity: {
            deviceId: identity?.deviceId ?? 0,
            inode: (identity?.inode ?? 0) + 1,
            size: identity?.size ?? path.size,
            modTimeMillis: identity?.modTimeMillis ?? path.modTimeMillis,
          },
        }),
      ).rejects.toThrow('local file changed before upload')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writeLocalFileInsideRoot', () => {
  it('writes bytes under the resolved root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-write-'))
    try {
      await writeLocalFileInsideRoot(root, 'nested/file.txt', textEncoder.encode('abc'))

      await expect(readFile(join(root, 'nested', 'file.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writeLocalStreamInsideRoot', () => {
  it('rejects download bodies that exceed the expected byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-overlong-'))
    try {
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abcd')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download read exceeded 3 byte limit')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects download bodies that end before the expected byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-truncated-'))
    try {
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 4,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download read ended after 3 bytes, expected 4')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
