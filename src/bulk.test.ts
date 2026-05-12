import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket, DeleteAllEvent, DeleteTarget } from './bucket.ts'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BufferSource } from './streams/source.ts'

function makeClient(): { client: B2Client; sim: B2Simulator } {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

async function uploadN(bucket: Bucket, n: number, prefix = ''): Promise<DeleteTarget[]> {
  const targets: DeleteTarget[] = []
  for (let i = 0; i < n; i++) {
    const name = `${prefix}file-${String(i).padStart(3, '0')}.txt`
    const result = await bucket.upload({
      fileName: name,
      source: new BufferSource(new TextEncoder().encode(`c${i}`)),
    })
    targets.push({ fileName: result.fileName, fileId: result.fileId })
  }
  return targets
}

describe('Bucket.deleteMany', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'bulk-many', bucketType: 'allPrivate' })
  })

  it('deletes every supplied target and reports the count', async () => {
    const targets = await uploadN(bucket, 5)
    const result = await bucket.deleteMany(targets)
    expect(result.deleted).toBe(5)
    expect(result.errors).toEqual([])

    const remaining = await bucket.listFileNames()
    expect(remaining.files).toHaveLength(0)
  })

  it('collects errors from individual failures without aborting the run', async () => {
    const targets = await uploadN(bucket, 3)
    const bogus: DeleteTarget = {
      fileName: 'ghost.txt',
      fileId: 'fake_file_id_999' as DeleteTarget['fileId'],
    }
    const result = await bucket.deleteMany([...targets, bogus])
    expect(result.deleted).toBe(3)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.target).toEqual(bogus)
  })

  it('respects the concurrency option', async () => {
    const targets = await uploadN(bucket, 10)
    const result = await bucket.deleteMany(targets, { concurrency: 2 })
    expect(result.deleted).toBe(10)
  })

  it('handles an empty target array gracefully', async () => {
    const result = await bucket.deleteMany([])
    expect(result.deleted).toBe(0)
    expect(result.errors).toEqual([])
  })
})

describe('Bucket.deleteAll', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'bulk-all', bucketType: 'allPrivate' })
  })

  it('streams delete events for every file version in the bucket', async () => {
    await uploadN(bucket, 7)

    const events: DeleteAllEvent[] = []
    for await (const event of bucket.deleteAll()) {
      events.push(event)
    }
    expect(events).toHaveLength(7)
    expect(events.every((e) => e.type === 'delete')).toBe(true)

    const remaining = await bucket.listFileNames()
    expect(remaining.files).toHaveLength(0)
  })

  it('with dryRun: true yields skip events and does not delete', async () => {
    await uploadN(bucket, 4)
    const events: DeleteAllEvent[] = []
    for await (const event of bucket.deleteAll({ dryRun: true })) {
      events.push(event)
    }
    expect(events).toHaveLength(4)
    expect(events.every((e) => e.type === 'skip')).toBe(true)

    const remaining = await bucket.listFileNames()
    expect(remaining.files).toHaveLength(4)
  })

  it('honours prefix filter', async () => {
    await uploadN(bucket, 3, 'photos/')
    await uploadN(bucket, 2, 'docs/')

    const events: DeleteAllEvent[] = []
    for await (const event of bucket.deleteAll({ prefix: 'photos/' })) {
      events.push(event)
    }
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.fileName.startsWith('photos/'))).toBe(true)

    const remaining = await bucket.listFileNames()
    expect(remaining.files).toHaveLength(2)
    expect(remaining.files.every((f) => f.fileName.startsWith('docs/'))).toBe(true)
  })

  it('paginates through more files than pageSize', async () => {
    await uploadN(bucket, 8)
    const events: DeleteAllEvent[] = []
    for await (const event of bucket.deleteAll({ pageSize: 3 })) {
      events.push(event)
    }
    expect(events).toHaveLength(8)
  })
})
