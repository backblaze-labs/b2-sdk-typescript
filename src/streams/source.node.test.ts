import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
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

  it('clamps slice bounds like built-in slice sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-bounds-'))
    try {
      const filePath = join(root, 'data.txt')
      await writeFile(filePath, 'abcd')

      const source = new FileSource(filePath, 4)

      await expect(new Response(source.slice(Number.NaN, 2).stream()).text()).resolves.toBe('ab')
      await expect(
        new Response(source.slice(1, Number.POSITIVE_INFINITY).stream()).text(),
      ).resolves.toBe('bcd')
      await expect(
        new Response(source.slice(Number.NEGATIVE_INFINITY, 2).stream()).text(),
      ).resolves.toBe('ab')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid file source ranges', () => {
    expect(() => new FileSource('data.bin', -1)).toThrow(
      'FileSource size must be a non-negative safe integer.',
    )
    expect(() => new FileSource('data.bin', Number.POSITIVE_INFINITY)).toThrow(
      'FileSource size must be a non-negative safe integer.',
    )
    expect(() => new FileSource('data.bin', 1, -1)).toThrow(
      'FileSource offset must be a non-negative safe integer.',
    )
  })

  it('rejects direct ranges beyond the current file size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-range-'))
    try {
      const filePath = join(root, 'data.bin')
      await writeFile(filePath, new Uint8Array([1, 2]))

      const source = new FileSource(filePath, 4)

      await expect(source.toArrayBuffer()).rejects.toThrow(
        `FileSource file is smaller than the requested range: ${filePath}`,
      )
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
