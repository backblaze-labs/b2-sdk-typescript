import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import type { B2Client } from '../client.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { uploadLargeFile } from './large.ts'

/**
 * Slow tier for `uploadLargeFile`: real multipart uploads that round-trip 5
 * MB+ through the simulator's per-part SHA-1 verification, plus the resume
 * flow which depends on the same multipart setup. Lives in a `*.slow.test.ts`
 * file so `pnpm test` (fast feedback) skips it; `pnpm test:slow` and
 * `pnpm test:coverage` pick it up. The slow vitest config pins
 * `maxForks: 1` and `testTimeout: 180_000`.
 */

describe('uploadLargeFile (real multipart, data > minPartSize)', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'multipart', bucketType: 'allPrivate' })
  })

  it('creates two parts and round-trips data correctly', async () => {
    const size = 5_000_010
    const data = deterministicBytes(size)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'two-parts.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
    })

    expect(result.contentLength).toBe(size)
    expect(result.fileName).toBe('two-parts.bin')

    const dl = await bucket.download('two-parts.bin')
    const downloaded = await readStream(dl.body)
    expect(downloaded).toEqual(data)
  })

  it('reports progress events during multipart upload', async () => {
    const size = 5_000_010
    const data = deterministicBytes(size)
    const events: { bytesTransferred: number; partsCompleted: number }[] = []

    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'progress.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
      onProgress: (event) => {
        events.push({
          bytesTransferred: event.bytesTransferred,
          partsCompleted: event.partsCompleted,
        })
      },
    })

    // addBytes + completePart per part = at least 4 events for 2 parts
    expect(events.length).toBeGreaterThanOrEqual(4)

    const last = events[events.length - 1]
    expect(last?.bytesTransferred).toBe(size)
    expect(last?.partsCompleted).toBe(2)

    // Audit anchor (ecosystem lesson 5): only 2 of 29 npm B2 packages emit
    // observable upload progress. Pin down the invariants callers rely on
    // so we never silently regress to fire-once-at-the-end or random order:
    //   - bytesTransferred is non-decreasing across the event sequence
    //   - partsCompleted is non-decreasing across the event sequence
    //   - the final event has bytesTransferred === total size and
    //     partsCompleted === total parts (already asserted above)
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]
      const cur = events[i]
      if (prev === undefined || cur === undefined) continue
      expect(cur.bytesTransferred).toBeGreaterThanOrEqual(prev.bytesTransferred)
      expect(cur.partsCompleted).toBeGreaterThanOrEqual(prev.partsCompleted)
    }
  })

  it('appears in bucket listing after multipart upload', async () => {
    const data = deterministicBytes(5_000_010)
    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'listed.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
    })

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(1)
    expect(listing.files[0]?.fileName).toBe('listed.bin')
    expect(listing.files[0]?.contentLength).toBe(5_000_010)
  })
})

describe('uploadLargeFile resume', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'resume-test', bucketType: 'allPrivate' })
  })

  it('resume: true re-uploads existing server parts by default', async () => {
    const size = 5_000_010
    const data = deterministicBytes(size)

    const startResp = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'resume-reupload.bin',
        contentType: 'application/octet-stream',
      },
    )
    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: startResp.fileId },
    )
    const part1Data = data.slice(0, 5_000_000)
    const { sha1Hex } = await import('../streams/hash.ts')
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1Data.byteLength,
        contentSha1: await sha1Hex(part1Data),
      },
      part1Data,
    )
    const uploadPart = vi.spyOn(client.raw, 'uploadPart')

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'resume-reupload.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
      resume: true,
    })

    expect(result.fileName).toBe('resume-reupload.bin')
    expect(uploadPart).toHaveBeenCalledTimes(2)
  })

  it('resume: true can opt into trusting matching server parts', async () => {
    const size = 5_000_010
    const data = deterministicBytes(size)

    // Step 1: start a large file and upload part 1 only, then leave it unfinished.
    const startResp = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'resumed.bin', contentType: 'application/octet-stream' },
    )

    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: startResp.fileId },
    )

    // Upload part 1 with the matching SHA-1 the resume path will recompute locally.
    const part1Data = data.slice(0, 5_000_000)
    const { sha1Hex } = await import('../streams/hash.ts')
    const part1Sha1 = await sha1Hex(part1Data)

    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part1Data.byteLength,
        contentSha1: part1Sha1,
      },
      part1Data,
    )
    const uploadPart = vi.spyOn(client.raw, 'uploadPart')

    // Step 2: resume with the same file name. Should find the unfinished file
    // via listUnfinishedLargeFiles, see part 1 already uploaded with matching SHA-1,
    // and only upload the remaining parts.
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'resumed.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
      resume: true,
      trustServerPartSha1s: true,
    })

    expect(result.fileName).toBe('resumed.bin')
    expect(result.contentLength).toBe(size)
    expect(uploadPart).toHaveBeenCalledTimes(1)
  })

  it('resume: true with no candidate falls back to a fresh upload', async () => {
    const data = deterministicBytes(5_000_010)
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'no-candidate.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
      resume: true,
    })

    expect(result.fileName).toBe('no-candidate.bin')
    expect(result.contentLength).toBe(data.byteLength)
  })

  it('resumeFileId targets a specific unfinished large file', async () => {
    const data = deterministicBytes(5_000_010)
    const start = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'explicit.bin', contentType: 'application/octet-stream' },
    )

    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'explicit.bin',
      source: new BufferSource(data),
      partSize: 5_000_000,
      concurrency: 1,
      resumeFileId: start.fileId,
    })

    expect(result.fileName).toBe('explicit.bin')
  })
})
