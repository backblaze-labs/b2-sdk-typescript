import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readStream } from '../test-utils/index.ts'
import { FileSource, StreamSource, toContentSource } from './source.ts'

const decoder = new TextDecoder()

describe('FileSource', () => {
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

  it('returns ranged slices without reading unrelated bytes', async () => {
    const path = join(tmpDir, 'range.txt')
    await writeFile(path, '0123456789')

    const source = new FileSource(path)
    const slice = source.slice(2, 7)

    expect(slice).toBeInstanceOf(FileSource)
    expect(slice.size).toBe(5)
    expect(decoder.decode(await slice.toArrayBuffer())).toBe('23456')
  })

  it('streams only the selected byte range', async () => {
    const path = join(tmpDir, 'stream.txt')
    await writeFile(path, 'prefix-body-suffix')

    const source = new FileSource(path).slice(7, 11)
    const bytes = await readStream(source.stream())

    expect(decoder.decode(bytes)).toBe('body')
  })
})

describe('Node Readable content sources', () => {
  it('wraps a Node Readable through the async-iterable path', async () => {
    const readable = Readable.from([new Uint8Array([1, 2]), new Uint8Array([3])])

    const source = toContentSource(readable, 3)

    expect(source).toBeInstanceOf(StreamSource)
    expect(await readStream(source.stream())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
