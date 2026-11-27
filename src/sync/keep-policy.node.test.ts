import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BufferSource } from '../streams/source.ts'
import { makeRemoteClient } from '../test-utils/remote-simulator.ts'
import { BucketType } from '../types/bucket.ts'
import { B2Folder } from './scanners/b2.ts'
import { LocalFolder } from './scanners/local.ts'
import { synchronize } from './synchronizer.ts'
import type { SyncEvent } from './types.ts'

describe('synchronize keep-days validation', () => {
  it('rejects omitted keepDays without deleting a just-uploaded orphan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-keep-days-'))
    try {
      const { client } = await makeRemoteClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: 'sync-keep-days',
        bucketType: BucketType.AllPrivate,
      })
      const uploaded = await bucket.upload({
        fileName: 'orphan.txt',
        source: new BufferSource(new TextEncoder().encode('recent orphan')),
      })
      const events: SyncEvent[] = []
      let failure: unknown
      try {
        for await (const event of synchronize({
          source: new LocalFolder(root),
          dest: new B2Folder(bucket, ''),
          options: { compareMode: 'size', keepMode: 'keep-days' },
          bucket,
          prefix: '',
        })) {
          events.push(event)
        }
      } catch (error) {
        failure = error
      }

      const listing = await bucket.listFileNames()
      expect(
        listing.files.map((file) => file.fileId),
        'the orphan must remain stored',
      ).toEqual([uploaded.fileId])
      expect(
        events.filter((event) => event.type === 'delete-remote' || event.type === 'hide'),
      ).toEqual([])
      expect(failure).toBeInstanceOf(RangeError)
      expect((failure as Error).message).toMatch(/keepDays/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
