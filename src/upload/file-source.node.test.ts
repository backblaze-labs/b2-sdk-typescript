import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import type { B2Client } from '../client.ts'
import { FileSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

describe('FileSource uploads', () => {
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

    const result = await bucket.upload({
      fileName: 'payload.bin',
      source: new FileSource(path),
      partSize: 100,
      concurrency: 2,
    })

    expect(result.fileName).toBe('payload.bin')
    expect(result.contentLength).toBe(data.byteLength)

    const downloaded = await bucket.download('payload.bin')
    expect(await readStream(downloaded.body)).toEqual(data)
  })

  it('rejects multipart upload if the file changes after FileSource construction', async () => {
    const path = join(tmpDir, 'mutated.bin')
    const data = deterministicBytes(250)
    await writeFile(path, data)

    const source = new FileSource(path)
    await writeFile(path, deterministicBytes(250).reverse())

    await expect(
      bucket.upload({
        fileName: 'mutated.bin',
        source,
        partSize: 100,
        concurrency: 2,
      }),
    ).rejects.toThrow(path)

    const listing = await bucket.listFileNames()
    expect(listing.files.find((file) => file.fileName === 'mutated.bin')).toBeUndefined()
  })
})
