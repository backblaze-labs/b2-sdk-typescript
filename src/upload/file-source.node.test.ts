import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import type { B2Client } from '../client.ts'
import { type ContentSource, FileSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

describe.skipIf(process.platform === 'win32')('FileSource uploads', () => {
  let tmpDir: string
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'b2sdk-upload-filesource-'))
    ;({ client } = makeClient({ minimumPartSize: 100, recommendedPartSize: 100 }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'file-source-upload',
      bucketType: BucketType.AllPrivate,
    })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('uses ranged file reads on the multipart upload path', async () => {
    const path = join(tmpDir, 'payload.bin')
    const data = deterministicBytes(250)
    await writeFile(path, data)

    // a round trip passes even if parts were read through a whole-file path,
    // so record the ranges the upload engine actually asked the source for.
    const sliceSpy = vi.spyOn(FileSource.prototype, 'slice')
    const result = await bucket.upload({
      fileName: 'payload.bin',
      source: new FileSource(path),
      partSize: 100,
      concurrency: 2,
    })
    // Each part range is requested (more than once: hashing and sending); only
    // the part ranges may appear, never one whole-file slice.
    const ranges = [...new Set(sliceSpy.mock.calls.map(([start, end]) => `${start}-${end}`))]
    sliceSpy.mockRestore()
    expect(ranges.sort()).toEqual(['0-100', '100-200', '200-250'])

    expect(result.fileName).toBe('payload.bin')
    expect(result.contentLength).toBe(data.byteLength)

    const downloaded = await bucket.download('payload.bin')
    expect(await readStream(downloaded.body)).toEqual(data)
  })

  it('rejects multipart upload if the path is replaced during part reads', async () => {
    const path = join(tmpDir, 'mutated.bin')
    const data = deterministicBytes(250)
    await writeFile(path, data)

    class MutatingFileSource extends FileSource {
      private mutated = false

      override slice(start: number, end: number): ContentSource {
        const part = super.slice(start, end)
        if (start !== 0) return part

        return {
          canSlice: part.canSlice,
          size: part.size,
          slice: part.slice.bind(part),
          stream: part.stream.bind(part),
          toArrayBuffer: async () => {
            const bytes = await part.toArrayBuffer()
            if (!this.mutated) {
              this.mutated = true
              await rm(path)
              await writeFile(path, deterministicBytes(250).reverse())
            }
            return bytes
          },
        }
      }
    }

    const source = new MutatingFileSource(path)

    await expect(
      bucket.upload({
        fileName: 'mutated.bin',
        source,
        partSize: 100,
        concurrency: 1,
      }),
    ).rejects.toThrow(path)

    const listing = await bucket.listFileNames()
    expect(listing.files.find((file) => file.fileName === 'mutated.bin')).toBeUndefined()
  })
})
