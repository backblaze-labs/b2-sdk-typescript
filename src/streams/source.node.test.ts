import {
  appendFile,
  chmod,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStream } from '../test-utils/index.ts'
import { FileSource, toContentSource } from './source.ts'

const decoder = new TextDecoder()
const isWindows = process.platform === 'win32'

describe.skipIf(isWindows)('FileSource', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'b2sdk-filesource-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('stats a local file and exposes it as sliceable content', async () => {
    const path = join(tmpDir, 'payload.txt')
    await writeFile(path, 'hello from disk')

    const source = new FileSource(path)

    expect(source.size).toBe(15)
    expect(source.canSlice).toBe(true)
    expect(decoder.decode(await source.toArrayBuffer())).toBe('hello from disk')
  })

  it('can be created with asynchronous filesystem validation', async () => {
    const path = join(tmpDir, 'async-payload.txt')
    await writeFile(path, 'hello from async disk')

    const source = await FileSource.fromPath(path)

    expect(source.size).toBe(21)
    expect(source.canSlice).toBe(true)
    expect(decoder.decode(await source.toArrayBuffer())).toBe('hello from async disk')
  })

  it('fromPath does not use synchronous filesystem construction', async () => {
    const path = join(tmpDir, 'async-only-payload.txt')
    await writeFile(path, 'hello without sync stat')
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      throw new Error('sync filesystem path used')
    })

    try {
      const source = await FileSource.fromPath(path)

      expect(source.size).toBe(23)
      expect(decoder.decode(await source.toArrayBuffer())).toBe('hello without sync stat')
    } finally {
      getBuiltinModule.mockRestore()
    }
  })

  it('returns ranged slices without reading unrelated bytes', async () => {
    const path = join(tmpDir, 'range.txt')
    await writeFile(path, '0123456789')

    const source = new FileSource(path)
    const slice = source.slice(2, 7)

    expect(slice.canSlice).toBe(true)
    expect(slice.size).toBe(5)
    expect(decoder.decode(await slice.toArrayBuffer())).toBe('23456')
  })

  it('bounds slices to the captured file size', async () => {
    const path = join(tmpDir, 'bounded.txt')
    await writeFile(path, '0123456789')

    const source = new FileSource(path)
    const slice = source.slice(8, 99)

    expect(slice.size).toBe(2)
    expect(decoder.decode(await slice.toArrayBuffer())).toBe('89')
  })

  it('coerces fractional slice offsets to integers', async () => {
    const path = join(tmpDir, 'fractional.txt')
    await writeFile(path, '0123456789')

    const source = new FileSource(path)
    const slice = source.slice(1.9, 4.9)

    expect(slice.size).toBe(3)
    expect(decoder.decode(await slice.toArrayBuffer())).toBe('123')
  })

  it('rejects non-finite slice offsets', async () => {
    const path = join(tmpDir, 'nan-slice.txt')
    await writeFile(path, '0123456789')

    const source = new FileSource(path)

    expect(() => source.slice(Number.NaN, 4)).toThrow(/slice offsets must be finite/)
  })

  it('streams only the selected byte range', async () => {
    const path = join(tmpDir, 'stream.txt')
    await writeFile(path, 'prefix-body-suffix')

    const source = new FileSource(path).slice(7, 11)
    const bytes = await readStream(source.stream())

    expect(decoder.decode(bytes)).toBe('body')
  })

  it('streams an empty file', async () => {
    const path = join(tmpDir, 'empty.txt')
    await writeFile(path, '')

    const source = new FileSource(path)

    expect(await readStream(source.stream())).toEqual(new Uint8Array())
  })

  it('returns an empty buffer for an unchanged empty file', async () => {
    const path = join(tmpDir, 'empty-buffer.txt')
    await writeFile(path, '')

    const source = new FileSource(path)

    expect(new Uint8Array(await source.toArrayBuffer())).toEqual(new Uint8Array())
  })

  it('reads successfully while metadata still matches', async () => {
    const path = join(tmpDir, 'verify-unchanged.txt')
    await writeFile(path, 'stable payload')

    const source = new FileSource(path)

    await expect(source.toArrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('rejects a replaced empty file before reading it as a buffer', async () => {
    const path = join(tmpDir, 'empty-replaced-buffer.txt')
    await writeFile(path, '')

    const source = new FileSource(path)
    await writeFile(path, 'replacement')

    await expect(source.toArrayBuffer()).rejects.toThrow(/modified before read|changed before read/)
  })

  it('rejects a replaced empty file before streaming it', async () => {
    const path = join(tmpDir, 'empty-replaced-stream.txt')
    await writeFile(path, '')

    const source = new FileSource(path)
    await writeFile(path, 'replacement')

    await expect(readStream(source.stream())).rejects.toThrow(
      /modified before read|changed before read/,
    )
  })

  it('rejects non-regular files', () => {
    expect(() => new FileSource(tmpDir)).toThrow(/not a regular file/)
  })

  it('rejects filesystems without stable file identity', () => {
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule').mockReturnValue({
      constants: { O_RDONLY: 0 },
      lstatSync() {
        return {
          dev: 0,
          ino: 0,
          mode: 0,
          size: 1,
          mtimeMs: 1,
          ctimeMs: 1,
          isFile: () => true,
        }
      },
    })

    try {
      expect(() => new FileSource('/unstable')).toThrow(/stable file identity/)
    } finally {
      getBuiltinModule.mockRestore()
    }
  })

  it('explains when synchronous filesystem construction is unavailable', () => {
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)

    try {
      expect(() => new FileSource('/missing-sync-fs')).toThrow(/Node\.js 22\.3\+/)
    } finally {
      getBuiltinModule.mockRestore()
    }
  })

  it('preserves fromPath validation through public slices', async () => {
    const path = join(tmpDir, 'constructor.txt')
    await writeFile(path, 'safe payload')

    const source = await FileSource.fromPath(path)
    const slice = source.slice(0, 4)

    expect(source.size).toBe(12)
    await writeFile(path, 'changed payload')
    await expect(slice.toArrayBuffer()).rejects.toThrow(path)
  })

  it('rejects metadata-only ctime changes after construction', async () => {
    const path = join(tmpDir, 'chmod.txt')
    await writeFile(path, 'metadata-only')

    const source = new FileSource(path)
    await chmod(path, 0o400)

    await expect(source.toArrayBuffer()).rejects.toThrow(/modified before read/)
  })

  it('rejects if the file is truncated after construction', async () => {
    const path = join(tmpDir, 'truncate.txt')
    await writeFile(path, 'original payload')

    const source = new FileSource(path)
    await writeFile(path, 'short')

    await expect(source.toArrayBuffer()).rejects.toThrow(path)
  })

  it('rejects if the file grows after construction', async () => {
    const path = join(tmpDir, 'grown.txt')
    await writeFile(path, 'original payload')

    const source = new FileSource(path)
    await appendFile(path, ' with appended bytes')

    await expect(source.toArrayBuffer()).rejects.toThrow(path)
  })

  it('detects same-size rewrites with restored mtime', async () => {
    const path = join(tmpDir, 'restored-mtime.txt')
    const fixedTime = new Date('2026-01-01T00:00:00.000Z')
    await writeFile(path, 'original data')
    await utimes(path, fixedTime, fixedTime)

    const source = new FileSource(path)
    await writeFile(path, 'tampered data')
    await utimes(path, fixedTime, fixedTime)

    await expect(source.toArrayBuffer()).rejects.toThrow(/modified before read/)
  })

  it('rejects a path replaced by a symlink', async () => {
    const path = join(tmpDir, 'payload.txt')
    const secretPath = join(tmpDir, 'secret.txt')
    await writeFile(path, 'safe payload')
    await writeFile(secretPath, 'secret payload')

    const source = new FileSource(path)
    await rm(path)
    await symlink(secretPath, path)

    await expect(source.toArrayBuffer()).rejects.toThrow(path)
  })

  it('rejects a path replaced by another file', async () => {
    const path = join(tmpDir, 'replaced.txt')
    const replacementPath = join(tmpDir, 'replacement.txt')
    const originalTime = new Date('2026-01-01T00:00:00.000Z')
    const replacementTime = new Date('2026-01-02T00:00:00.000Z')
    await writeFile(path, 'safe payload')
    await utimes(path, originalTime, originalTime)
    await writeFile(replacementPath, 'evil payload')
    await utimes(replacementPath, replacementTime, replacementTime)

    const source = new FileSource(path)
    await rm(path)
    await rename(replacementPath, path)

    await expect(source.toArrayBuffer()).rejects.toThrow(/(?:changed|was modified) before read/)
  })
})

describe.runIf(isWindows)('FileSource on Windows', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'b2sdk-filesource-win-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects before a symlink replacement path can be uploaded', async () => {
    const path = join(tmpDir, 'payload.txt')
    await writeFile(path, 'safe payload')

    expect(() => new FileSource(path)).toThrow(/not supported on Windows/)
    await expect(FileSource.fromPath(path)).rejects.toThrow(/not supported on Windows/)
  })

  it('rejects before a same-size restored-mtime rewrite can be uploaded', async () => {
    const path = join(tmpDir, 'restored-mtime.txt')
    const fixedTime = new Date('2026-01-01T00:00:00.000Z')
    await writeFile(path, 'original data')
    await utimes(path, fixedTime, fixedTime)

    expect(() => new FileSource(path)).toThrow(/not supported on Windows/)
    await expect(FileSource.fromPath(path)).rejects.toThrow(/not supported on Windows/)
  })
})

describe('Node Readable content sources', () => {
  it('wraps a Node Readable through the async-iterable path', async () => {
    const readable = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3])])

    const source = toContentSource(readable, 3)

    expect(source.canSlice).toBe(false)
    expect(source.size).toBe(3)
    expect(await readStream(source.stream())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
