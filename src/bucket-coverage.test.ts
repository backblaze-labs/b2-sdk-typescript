import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BufferSource } from './streams/source.ts'
import { makeClient } from './test-utils/index.ts'
import { BucketType } from './types/bucket.ts'
import { EncryptionAlgorithm, EncryptionMode } from './types/encryption.ts'

/**
 * Branch-coverage tests for `Bucket.copyLargeFile` and `Bucket.deleteAll`.
 *
 * The success paths are already covered elsewhere, but several conditional
 * spreads and error-yield branches are uncovered:
 *
 *   - `Bucket.copyLargeFile` spreads `destinationBucketId`,
 *     `destinationServerSideEncryption`, and `sourceServerSideEncryption`
 *     only when supplied (bucket.ts lines 546, 551, 554).
 *   - `Bucket.deleteAll` yields an `error` event when an individual
 *     `deleteFileVersion` call throws (bucket.ts lines 470-476).
 *
 * The `copyLargeFile` tests use a `minimumPartSize: 100_000` simulator so
 * the multipart copy fits under the fast-tier budget while still
 * exercising the per-spread branch.
 */

function makeSmallPartClient(): { client: B2Client } {
  return makeClient({ minimumPartSize: 100_000 })
}

describe('Bucket.copyLargeFile branch coverage', () => {
  let client: B2Client
  let sourceBucket: Bucket
  let destBucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeSmallPartClient())
    await client.authorize()
    sourceBucket = await client.createBucket({
      bucketName: 'src-bucket',
      bucketType: BucketType.AllPrivate,
    })
    destBucket = await client.createBucket({
      bucketName: 'dst-bucket',
      bucketType: BucketType.AllPrivate,
    })
  })

  async function uploadSource(name: string): Promise<{ fileId: import('./types/ids.ts').FileId }> {
    const data = new Uint8Array(200_000) // 2 parts at 100KB each
    for (let i = 0; i < data.byteLength; i++) data[i] = i & 0xff
    const result = await sourceBucket.upload({
      fileName: name,
      source: new BufferSource(data),
      partSize: 100_000,
      concurrency: 1,
    })
    return { fileId: result.fileId }
  }

  it('forwards an explicit destinationBucketId different from the source (line 546)', async () => {
    const src = await uploadSource('src1.bin')
    const result = await sourceBucket.copyLargeFile({
      sourceFileId: src.fileId,
      fileName: 'into-other-bucket.bin',
      destinationBucketId: destBucket.id,
      partSize: 100_000,
      concurrency: 1,
    })
    expect(result.fileName).toBe('into-other-bucket.bin')
    // The copy should land in destBucket, not sourceBucket.
    const dstListing = await destBucket.listFileNames()
    expect(dstListing.files.map((f) => f.fileName)).toContain('into-other-bucket.bin')
  })

  it('forwards destinationServerSideEncryption when supplied (line 551)', async () => {
    const src = await uploadSource('src2.bin')
    const result = await sourceBucket.copyLargeFile({
      sourceFileId: src.fileId,
      fileName: 'sse-dst.bin',
      destinationServerSideEncryption: {
        mode: EncryptionMode.SseB2,
        algorithm: EncryptionAlgorithm.Aes256,
      },
      partSize: 100_000,
      concurrency: 1,
    })
    expect(result.fileName).toBe('sse-dst.bin')
  })

  it('forwards sourceServerSideEncryption when supplied (line 554)', async () => {
    const src = await uploadSource('src3.bin')
    const result = await sourceBucket.copyLargeFile({
      sourceFileId: src.fileId,
      fileName: 'sse-src.bin',
      sourceServerSideEncryption: { mode: EncryptionMode.None },
      partSize: 100_000,
      concurrency: 1,
    })
    expect(result.fileName).toBe('sse-src.bin')
  })

  it('forwards all option spreads in one call (lines 546+551+554+contentType+fileInfo)', async () => {
    const src = await uploadSource('src4.bin')
    const result = await sourceBucket.copyLargeFile({
      sourceFileId: src.fileId,
      fileName: 'everything.bin',
      destinationBucketId: destBucket.id,
      contentType: 'application/octet-stream',
      fileInfo: { tag: 'cov' },
      destinationServerSideEncryption: {
        mode: EncryptionMode.SseB2,
        algorithm: EncryptionAlgorithm.Aes256,
      },
      sourceServerSideEncryption: { mode: EncryptionMode.None },
      partSize: 100_000,
      concurrency: 1,
    })
    expect(result.fileName).toBe('everything.bin')
  })
})

describe('Bucket.deleteAll error-yield path', () => {
  it('yields an error event when an individual deleteFileVersion call fails', async () => {
    // Upload two files, then have the SECOND b2_delete_file_version call
    // fail. deleteAll should yield one `delete` event (success) and one
    // `error` event, then keep going to completion. Lines 470-476 in
    // bucket.ts handle the error yield.
    const sim = new B2Simulator()
    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'delete-all-err',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'a.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.upload({
      fileName: 'b.txt',
      source: new BufferSource(new Uint8Array([2])),
    })

    // Skip the first b2_delete_file_version, fail the second once.
    sim.injectFailure({
      on: 'b2_delete_file_version',
      skip: 1,
      count: 1,
      status: 400,
      code: 'bad_request',
      message: 'simulated delete failure',
    })

    const events: Array<{ type: string; fileName: string }> = []
    for await (const event of bucket.deleteAll()) {
      events.push({ type: event.type, fileName: event.fileName })
    }

    // We expect one success and one error across the two uploaded files.
    // (Order depends on B2's list-file-versions ordering, so don't assert
    // which file failed; assert that we got one of each.)
    const types = events.map((e) => e.type).sort()
    expect(types).toEqual(['delete', 'error'])
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
  })
})
