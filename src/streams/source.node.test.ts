import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { FileSource } from './source.ts'

const execFileAsync = promisify(execFile)
const isLinux = process.platform === 'linux'

describe('FileSource', () => {
  it('rejects invalid internal byte counts', () => {
    const UnsafeFileSource = FileSource as unknown as {
      new (
        filePath: string,
        size: number,
        identity: {
          dev: number
          ino: number
          size: number
          mtimeMs: number
          ctimeMs: number
        },
      ): FileSource
    }

    expect(
      () =>
        new UnsafeFileSource('data.bin', -1, {
          dev: 1,
          ino: 1,
          size: 0,
          mtimeMs: 0,
          ctimeMs: 0,
        }),
    ).toThrow('FileSource size must be a non-negative safe integer')
  })

  it('streams and slices a local file by byte range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-'))
    try {
      const filePath = join(root, 'data.txt')
      await writeFile(filePath, 'hello world')

      const source = await FileSource.fromPath(filePath)
      expect(source.size).toBe(11)
      expect(source.canSlice).toBe(true)

      const streamed = await new Response(source.stream()).arrayBuffer()
      expect(new TextDecoder().decode(streamed)).toBe('hello world')

      const sliced = source.slice(6, 11)
      const bytes = await sliced.toArrayBuffer()
      expect(new TextDecoder().decode(bytes)).toBe('world')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds relative paths at validation time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-relative-'))
    const originalCwd = process.cwd()
    try {
      const first = join(root, 'first')
      const second = join(root, 'second')
      await mkdir(first)
      await mkdir(second)
      await writeFile(join(first, 'data.bin'), new TextEncoder().encode('first'))
      await writeFile(join(second, 'data.bin'), new TextEncoder().encode('second'))

      process.chdir(first)
      const source = await FileSource.fromPath('data.bin')
      process.chdir(second)

      const bytes = await source.toArrayBuffer()
      expect(new TextDecoder().decode(bytes)).toBe('first')
      await expect(realpath(source.filePath)).resolves.toBe(await realpath(join(first, 'data.bin')))
    } finally {
      process.chdir(originalCwd)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('streams an empty local file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-empty-'))
    try {
      const filePath = join(root, 'empty.bin')
      await writeFile(filePath, new Uint8Array())

      const source = await FileSource.fromPath(filePath)
      expect(source.size).toBe(0)
      await expect(new Response(source.stream()).arrayBuffer()).resolves.toHaveProperty(
        'byteLength',
        0,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when a validated empty file grows before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-empty-grown-'))
    try {
      const filePath = join(root, 'empty.bin')
      await writeFile(filePath, new Uint8Array())

      const source = await FileSource.fromPath(filePath)
      await writeFile(filePath, new TextEncoder().encode('grown'))

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file changed after validation: ${filePath}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes the local file handle when a stream is canceled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-cancel-'))
    try {
      const filePath = join(root, 'large.bin')
      const renamedPath = join(root, 'renamed.bin')
      await writeFile(filePath, new Uint8Array(64 * 1024 + 1))

      const source = await FileSource.fromPath(filePath)
      const reader = source.stream().getReader()
      const firstChunk = await reader.read()
      expect(firstChunk.done).toBe(false)
      await reader.cancel()

      await rename(filePath, renamedPath)
      expect((await readFile(renamedPath)).byteLength).toBe(64 * 1024 + 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clamps slice bounds like built-in slice sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-bounds-'))
    try {
      const filePath = join(root, 'data.txt')
      await writeFile(filePath, 'abcd')

      const source = await FileSource.fromPath(filePath)

      await expect(new Response(source.slice(Number.NaN, 2).stream()).text()).resolves.toBe('ab')
      await expect(
        new Response(source.slice(1, Number.POSITIVE_INFINITY).stream()).text(),
      ).resolves.toBe('bcd')
      await expect(
        new Response(source.slice(Number.NEGATIVE_INFINITY, 2).stream()).text(),
      ).resolves.toBe('ab')
      await expect(new Response(source.slice(-3, -1).stream()).text()).resolves.toBe('bc')
      await expect(
        new Response(source.slice(-2, Number.POSITIVE_INFINITY).stream()).text(),
      ).resolves.toBe('cd')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects non-regular local paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-dir-'))
    try {
      await expect(FileSource.fromPath(root)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!isLinux)('rejects fifo paths without waiting for a writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-fifo-'))
    let unblockPromise: Promise<void> | undefined
    try {
      const fifoPath = join(root, 'pipe')
      await execFileAsync('mkfifo', [fifoPath])
      let neededWriterToUnblock = false
      const unblockTimer = setTimeout(() => {
        neededWriterToUnblock = true
        unblockPromise = open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
          .then((handle) => handle.close())
          .catch(() => {})
      }, 100)

      try {
        await expect(FileSource.fromPath(fifoPath)).rejects.toThrow()
      } finally {
        clearTimeout(unblockTimer)
        await unblockPromise
      }
      expect(neededWriterToUnblock).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when the validated file is truncated before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-truncate-'))
    try {
      const filePath = join(root, 'data.bin')
      await writeFile(filePath, new Uint8Array([1, 2, 3, 4]))

      const source = await FileSource.fromPath(filePath)
      await truncate(filePath, 2)

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file changed after validation: ${filePath}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when the validated file content changes before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-mutated-'))
    try {
      const filePath = join(root, 'data.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))

      const source = await FileSource.fromPath(filePath)
      await writeFile(filePath, new TextEncoder().encode('evil'))
      const changedTime = new Date(Date.now() + 10_000)
      await utimes(filePath, changedTime, changedTime)

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file changed after validation: ${filePath}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects same-size rewrites when mtime is restored before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-ctime-'))
    try {
      const filePath = join(root, 'data.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))
      const originalTime = new Date('2024-01-01T00:00:00.000Z')
      await utimes(filePath, originalTime, originalTime)

      const source = await FileSource.fromPath(filePath)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile(filePath, new TextEncoder().encode('evil'))
      await utimes(filePath, originalTime, originalTime)

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file changed after validation: ${filePath}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when the validated file is replaced before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-replaced-'))
    try {
      const filePath = join(root, 'data.bin')
      const replacementPath = join(root, 'replacement.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))
      await writeFile(replacementPath, new TextEncoder().encode('evil'))

      const source = await FileSource.fromPath(filePath)
      await rename(replacementPath, filePath)

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file changed after validation: ${filePath}`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not follow a symlink swapped in after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-symlink-'))
    try {
      const filePath = join(root, 'data.bin')
      const secretPath = join(root, 'secret.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))
      await writeFile(secretPath, new TextEncoder().encode('secret'))

      const source = await FileSource.fromPath(filePath)
      await rm(filePath)
      await symlink(secretPath, filePath)

      await expect(source.toArrayBuffer()).rejects.toThrow()
      expect(new TextDecoder().decode(await readFile(secretPath))).toBe('secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
