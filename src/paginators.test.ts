import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import type { B2Client } from './client.ts'
import { BufferSource } from './streams/source.ts'
import { makeClient } from './test-utils/index.ts'
import { Capability } from './types/auth.ts'
import { BucketType } from './types/bucket.ts'

/**
 * Integration tests for the per-endpoint paginator methods on `Bucket`
 * and `B2Client`, wired through the in-memory `B2Simulator`. The generic
 * `paginate*` factory has unit-test coverage in `util/paginator.test.ts`;
 * these tests exercise the cursor extraction + flattening glue per
 * endpoint, against real-shaped responses.
 */

async function setup(options?: {
  /** Override `absoluteMinimumPartSize` so a test can use 100 KB parts
   *  instead of the 5 MB production default. Keeps the fast tier fast. */
  minimumPartSize?: number
}): Promise<{ client: B2Client; bucket: Bucket }> {
  const { client } = makeClient(
    options?.minimumPartSize !== undefined ? { minimumPartSize: options.minimumPartSize } : {},
  )
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'paginate-bucket',
    bucketType: BucketType.AllPrivate,
  })
  return { client, bucket }
}

describe('Bucket.paginateFileNames', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await setup())
    // Upload 7 files; paginate in pages of 3 to force pagination.
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']) {
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(name)),
        contentType: 'text/plain',
      })
    }
  })

  it('yields every file across pages, in name order', async () => {
    const names: string[] = []
    for await (const file of bucket.paginateFileNames({ pageSize: 3 })) {
      names.push(file.fileName)
    }
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'])
  })

  it('applies a prefix filter across pages', async () => {
    // Add a few extra "logs/" entries.
    for (const name of ['logs/2024-01.log', 'logs/2024-02.log', 'logs/2024-03.log']) {
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(name)),
        contentType: 'text/plain',
      })
    }
    const names: string[] = []
    for await (const file of bucket.paginateFileNames({ prefix: 'logs/', pageSize: 2 })) {
      names.push(file.fileName)
    }
    expect(names).toEqual(['logs/2024-01.log', 'logs/2024-02.log', 'logs/2024-03.log'])
  })

  it('aborts mid-iteration', async () => {
    const controller = new AbortController()
    const names: string[] = []
    await expect(
      (async () => {
        for await (const file of bucket.paginateFileNames({
          pageSize: 2,
          signal: controller.signal,
        })) {
          names.push(file.fileName)
          // Abort after seeing the second item; the iterator should NOT
          // fetch the next page.
          if (names.length === 2) controller.abort()
        }
      })(),
    ).rejects.toThrow()
    expect(names).toEqual(['a.txt', 'b.txt'])
  })

  it('yields nothing on an empty bucket', async () => {
    const empty = await (await setup()).bucket // separate bucket, no uploads
    const names: string[] = []
    for await (const file of empty.paginateFileNames()) names.push(file.fileName)
    expect(names).toEqual([])
  })

  it('handles the minimum pageSize: 1 without dropping or duplicating entries', async () => {
    // Boundary test: at pageSize 1, every yield is also a page boundary,
    // so the cursor handoff between pages runs N-1 times for N files.
    // This is the most cursor-stress scenario possible — a bug in the
    // boundary logic (off-by-one cursor, dropped item on page-end,
    // replayed item on page-start) shows up here far more reliably than
    // at the default pageSize 1000. The existing test for 7 files at
    // pageSize 3 exercises 2-3 page transitions; this exercises 7.
    const names: string[] = []
    for await (const file of bucket.paginateFileNames({ pageSize: 1 })) {
      names.push(file.fileName)
    }
    expect(names).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt'])
  })
})

describe('Bucket.paginateFileVersions', () => {
  it('yields every version of every file across pages', async () => {
    const { bucket } = await setup()
    // Upload two files with two versions each.
    for (const name of ['a.txt', 'b.txt']) {
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(`${name}-v1`)),
      })
      await bucket.upload({
        fileName: name,
        source: new BufferSource(new TextEncoder().encode(`${name}-v2`)),
      })
    }
    const seen: string[] = []
    for await (const v of bucket.paginateFileVersions({ pageSize: 2 })) {
      seen.push(v.fileName)
    }
    // 2 files × 2 versions = 4 entries. listFileVersions sorts ascending
    // by name, then descending by upload timestamp, so each name appears
    // twice in sequence.
    expect(seen.length).toBe(4)
    expect(seen.filter((n) => n === 'a.txt').length).toBe(2)
    expect(seen.filter((n) => n === 'b.txt').length).toBe(2)
  })

  it('threads the (startFileName, startFileId) cursor correctly across many versions of one file', async () => {
    // Regression test for a pagination bug where the simulator only
    // honoured `startFileName` and ignored `startFileId`. With many
    // versions of a single file, paginating with a small pageSize would
    // replay the last entry of page N as the first entry of page N+1
    // and skip intervening versions. The fix threads both cursor
    // components composite-style.
    const { bucket } = await setup()
    const N = 7
    for (let i = 0; i < N; i++) {
      await bucket.upload({
        fileName: 'single.bin',
        source: new BufferSource(new TextEncoder().encode(`v${i}`)),
      })
    }
    // Paginate with a pageSize that doesn't evenly divide N so the
    // boundary lands inside the version stack.
    const seenFileIds: string[] = []
    for await (const v of bucket.paginateFileVersions({ pageSize: 2 })) {
      seenFileIds.push(v.fileId)
    }
    // Every version must appear exactly once, no duplicates and no drops.
    expect(seenFileIds.length).toBe(N)
    expect(new Set(seenFileIds).size).toBe(N)
  })
})

describe('Bucket.paginateUnfinishedLargeFiles', () => {
  it('yields every started-but-not-finished large file', async () => {
    const { client, bucket } = await setup()
    // Start three large files without finishing them. The raw API gives
    // us startLargeFile so we can leave them in the "unfinished" state.
    for (const name of ['unfinished-1.bin', 'unfinished-2.bin', 'unfinished-3.bin']) {
      await client.raw.startLargeFile(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id, fileName: name, contentType: 'application/octet-stream' },
      )
    }
    const names: string[] = []
    for await (const f of bucket.paginateUnfinishedLargeFiles({ pageSize: 2 })) {
      names.push(f.fileName)
    }
    expect(names.sort()).toEqual(['unfinished-1.bin', 'unfinished-2.bin', 'unfinished-3.bin'])
  })

  it('honors the namePrefix filter', async () => {
    const { client, bucket } = await setup()
    for (const name of ['logs/a.bin', 'logs/b.bin', 'photos/x.bin']) {
      await client.raw.startLargeFile(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id, fileName: name, contentType: 'application/octet-stream' },
      )
    }
    const names: string[] = []
    for await (const f of bucket.paginateUnfinishedLargeFiles({ namePrefix: 'logs/' })) {
      names.push(f.fileName)
    }
    expect(names.sort()).toEqual(['logs/a.bin', 'logs/b.bin'])
  })
})

describe('Bucket.paginateParts', () => {
  it('yields every uploaded part of a specific large file', async () => {
    // 100 KB minimum-part-size so this fits in the fast tier. A 5 MB
    // simulator default × 5 parts × per-part SHA-1 round-trip pushes
    // this test past the fast budget (and trips coverage runs on slow
    // CI). The pagination control flow exercised here is independent
    // of part size, so shrinking is safe.
    const { client, bucket } = await setup({ minimumPartSize: 100_000 })
    const start = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id, fileName: 'parts.bin', contentType: 'application/octet-stream' },
    )
    const partUrl = await client.raw.getUploadPartUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: start.fileId },
    )
    const { sha1Hex } = await import('./streams/hash.ts')
    for (let partNumber = 1; partNumber <= 5; partNumber++) {
      const data = new Uint8Array(100_000)
      // Fill so each part has distinct content (SHA-1 differs per part).
      data.fill(partNumber)
      const hash = await sha1Hex(data)
      await client.raw.uploadPart(
        partUrl.uploadUrl,
        {
          authorization: partUrl.authorizationToken,
          partNumber,
          contentLength: data.byteLength,
          contentSha1: hash,
        },
        data,
      )
    }
    const partNumbers: number[] = []
    for await (const p of bucket.paginateParts(start.fileId, { pageSize: 2 })) {
      partNumbers.push(p.partNumber)
    }
    expect(partNumbers).toEqual([1, 2, 3, 4, 5])
  })
})

describe('B2Client.paginateKeys', () => {
  it('yields every application key across pages', async () => {
    const { client } = await setup()
    // Create 4 application keys. paginate in pages of 2.
    for (const name of ['k1', 'k2', 'k3', 'k4']) {
      await client.createKey({
        keyName: name,
        capabilities: [Capability.ReadFiles],
      })
    }
    const names: string[] = []
    for await (const key of client.paginateKeys({ pageSize: 2 })) {
      names.push(key.keyName)
    }
    // Simulator may return keys in insertion order or otherwise.
    // Assert membership rather than order.
    expect(new Set(names)).toEqual(new Set(['k1', 'k2', 'k3', 'k4']))
  })

  it('aborts mid-iteration', async () => {
    const { client } = await setup()
    for (const name of ['k1', 'k2', 'k3', 'k4']) {
      await client.createKey({
        keyName: name,
        capabilities: [Capability.ReadFiles],
      })
    }
    const controller = new AbortController()
    const seen: string[] = []
    await expect(
      (async () => {
        for await (const key of client.paginateKeys({ pageSize: 2, signal: controller.signal })) {
          seen.push(key.keyName)
          if (seen.length === 2) controller.abort()
        }
      })(),
    ).rejects.toThrow()
    expect(seen.length).toBe(2)
  })
})
