import { describe, expect, it } from 'vitest'
import { sha1Hex } from '../streams/hash.ts'
import { formatHashError, isAbortError, readLocalSha1File } from './local-sha1.ts'
import type { LocalFileIdentity, LocalSyncPath } from './types.ts'

const processLike = (globalThis as { process?: { platform?: string } }).process
const isWindows = processLike?.platform === 'win32'

function makeLocalPath(
  relativePath: string,
  absolutePath: string,
  size: number,
  fileIdentity?: LocalFileIdentity,
): LocalSyncPath {
  return {
    relativePath,
    absolutePath,
    modTimeMillis: 1000,
    size,
    ...(fileIdentity !== undefined ? { fileIdentity } : {}),
  }
}

describe('readLocalSha1File', () => {
  it('hashes regular files and normalizes invalid timeout values', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-sha1-'))
    try {
      const data = new TextEncoder().encode('abc')
      const filePath = join(root, 'file.txt')
      await writeFile(filePath, data)

      await expect(
        readLocalSha1File(makeLocalPath('file.txt', filePath, data.byteLength), undefined, {
          timeoutMillis: Number.NaN,
        }),
      ).resolves.toBe(await sha1Hex(data))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hashes empty files with an explicit idle timeout', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-sha1-empty-'))
    try {
      const filePath = join(root, 'empty.txt')
      await writeFile(filePath, new Uint8Array())

      await expect(
        readLocalSha1File(makeLocalPath('empty.txt', filePath, 0), undefined, {
          timeoutMillis: 1000.9,
        }),
      ).resolves.toBe(await sha1Hex(new Uint8Array()))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects files whose scanned size changed', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-sha1-size-'))
    try {
      const filePath = join(root, 'changed.txt')
      await writeFile(filePath, 'abc')

      await expect(readLocalSha1File(makeLocalPath('changed.txt', filePath, 4))).rejects.toThrow(
        'local file changed before sha1 comparison: size changed',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('rejects symlinks before hashing', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtemp, rm, symlink, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-sha1-link-'))
    try {
      const targetPath = join(root, 'target.txt')
      const linkPath = join(root, 'link.txt')
      await writeFile(targetPath, 'abc')
      await symlink(targetPath, linkPath)

      await expect(readLocalSha1File(makeLocalPath('link.txt', linkPath, 3))).rejects.toThrow(
        'local file changed before sha1 comparison: not a regular file',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects same-size rewrites whose mtime was restored before hashing', async () => {
    const { tmpdir } = await import('node:os')
    const { mkdtemp, rm, stat, utimes, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-sha1-ctime-'))
    try {
      const filePath = join(root, 'changed.txt')
      await writeFile(filePath, 'safe')
      const originalTime = new Date('2024-01-01T00:00:00.000Z')
      await utimes(filePath, originalTime, originalTime)
      const stats = await stat(filePath)
      const path = makeLocalPath('changed.txt', filePath, 4, {
        deviceId: stats.dev,
        inode: stats.ino,
        size: stats.size,
        modTimeMillis: Math.floor(stats.mtimeMs),
        changeTimeMillis: Math.floor(stats.ctimeMs),
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile(filePath, 'evil')
      await utimes(filePath, originalTime, originalTime)

      await expect(readLocalSha1File(path)).rejects.toThrow(
        'local file changed before sha1 comparison',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('observes an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      readLocalSha1File(makeLocalPath('aborted.txt', '/not/read', 0), controller.signal),
    ).rejects.toThrow()
  })
})

describe('formatHashError', () => {
  it('prefers stable error codes', () => {
    const error = Object.assign(new Error("ENOENT: open '/tmp/file.txt'"), { code: 'ENOENT' })
    expect(formatHashError(error)).toBe('ENOENT')
  })

  it('uses safe messages without filesystem separators', () => {
    expect(formatHashError(new Error('not a regular file'))).toBe('not a regular file')
  })

  it('falls back to the error name for path-bearing messages', () => {
    const error = new Error("EACCES: open '/tmp/file.txt'")
    error.name = 'PathError'
    expect(formatHashError(error)).toBe('PathError')
  })

  it('falls back to a generic label when no safe reason exists', () => {
    const error = new Error('/tmp/file.txt')
    error.name = ''
    expect(formatHashError(error)).toBe('Error')
  })
})

describe('isAbortError', () => {
  it('identifies DOM abort errors', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('not aborted'))).toBe(false)
  })
})
