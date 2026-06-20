import {
  chmod,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSource } from './source.ts'

describe('FileSource', () => {
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

  it('allows metadata-only ctime changes before reading unchanged bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-ctime-'))
    try {
      const filePath = join(root, 'data.bin')
      const payload = new TextEncoder().encode('safe')
      await writeFile(filePath, payload)

      const source = await FileSource.fromPath(filePath)
      await chmod(filePath, 0o600)

      const bytes = new Uint8Array(await source.toArrayBuffer())
      expect(bytes).toEqual(payload)
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
