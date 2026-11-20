import { describe, expect, it } from 'vitest'
import { BufferSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

describe('copy findings', () => {
  it('Finding C23: Bucket.copyFile without destinationBucketId copies into this bucket', async () => {
    const { client } = makeClient()
    await client.authorize()
    const src = await client.createBucket({
      bucketName: 'copy-c23-src',
      bucketType: BucketType.AllPrivate,
    })
    const dst = await client.createBucket({
      bucketName: 'copy-c23-dst',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await src.upload({
      fileName: 'a.txt',
      source: new BufferSource(new TextEncoder().encode('hello')),
    })

    const copied = await dst.copyFile({ sourceFileId: uploaded.fileId, fileName: 'b.txt' })

    expect(copied.bucketId, 'copy landed in a different bucket than expected').toBe(dst.id)
    const explicit = await dst.copyFile({
      sourceFileId: uploaded.fileId,
      fileName: 'explicit.txt',
      destinationBucketId: src.id,
    })
    expect(explicit.bucketId).toBe(src.id)
  })
})
