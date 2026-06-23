import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  deleteLocalFileInsideRoot,
  localFileIoTestHooks,
  readScannedLocalFile,
  writeLocalFileInsideRoot,
  writeLocalStreamInsideRoot,
} from './local-file-io.ts'
import { createSyncDownloadTempFileSweeper, syncDownloadTempName } from './temp-files.ts'
import type { LocalSyncPath } from './types.ts'

const textEncoder = new TextEncoder()
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const execFileAsync = promisify(execFile)

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

      const result = await readScannedLocalFile(path)
      expect(result).toBeInstanceOf(Uint8Array)
      expect([...result]).toEqual([...textEncoder.encode('abc')])
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

  it('rejects a scanned file removed before upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-missing-'))
    try {
      const path = await makeScannedPath(root, 'file.txt', 'abc')
      await rm(path.absolutePath, { force: true })

      await expect(readScannedLocalFile(path)).rejects.toThrow(
        'local file changed before upload: could not open scanned file: ENOENT',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('rejects a scanned file replaced by a FIFO without hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-fifo-'))
    try {
      const path = await makeScannedPath(root, 'pipe.txt', 'abc')
      await rm(path.absolutePath, { force: true })
      await execFileAsync('mkfifo', [path.absolutePath])

      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for FIFO rejection')), 1500)
      })

      await expect(Promise.race([readScannedLocalFile(path), timeout])).rejects.toThrow(
        'local file changed before upload: not a regular file',
      )
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

  it('sweeps owned partial download files before writing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-sweep-'))
    try {
      const sweeper = createSyncDownloadTempFileSweeper('run')
      const orphanName = syncDownloadTempName('run', 'orphan')
      const otherName = syncDownloadTempName('other', 'orphan')
      await writeFile(join(root, orphanName), 'old')
      await writeFile(join(root, otherName), 'other')

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
          downloadTempFileSweeper: sweeper,
        },
      )

      await expect(readFile(join(root, orphanName))).rejects.toThrow()
      await expect(readFile(join(root, otherName), 'utf8')).resolves.toBe('other')
      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!isLinux)('does not follow a parent symlink swap during final rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-out-'))
    try {
      await mkdir(join(root, 'safe'))
      localFileIoTestHooks.beforeFinalRename = async () => {
        await rename(join(root, 'safe'), join(root, 'safe-real'))
        await symlink(outside, join(root, 'safe'), 'dir')
      }

      await writeLocalStreamInsideRoot(
        root,
        'safe/payload.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(outside, 'payload.txt'))).rejects.toThrow()
      await expect(readFile(join(root, 'safe-real', 'payload.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      delete localFileIoTestHooks.beforeFinalRename
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('deleteLocalFileInsideRoot', () => {
  it.skipIf(!isLinux)('does not follow a parent symlink swap during unlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-out-'))
    try {
      await mkdir(join(root, 'safe'))
      const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')
      await writeFile(join(outside, 'victim.txt'), 'keep')

      localFileIoTestHooks.beforeLocalDeleteUnlink = async () => {
        await rename(join(root, 'safe'), join(root, 'safe-real'))
        await symlink(outside, join(root, 'safe'), 'dir')
      }

      await deleteLocalFileInsideRoot(root, scannedPath)

      await expect(readFile(join(outside, 'victim.txt'), 'utf8')).resolves.toBe('keep')
      await expect(readFile(join(root, 'safe-real', 'victim.txt'))).rejects.toThrow()
    } finally {
      delete localFileIoTestHooks.beforeLocalDeleteUnlink
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
