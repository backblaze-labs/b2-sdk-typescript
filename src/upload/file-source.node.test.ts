import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { uploadLargeFile } from './large.ts'

describe('uploadLargeFile with FileSource', () => {
  it('cancels the unfinished large file when the source changes before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-file-source-upload-'))
    try {
      const filePath = join(root, 'data.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))
      const source = await FileSource.fromPath(filePath)
      await writeFile(filePath, new TextEncoder().encode('evil'))

      const { client } = makeClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: 'file-source-upload',
        bucketType: BucketType.AllPrivate,
      })

      await expect(
        uploadLargeFile(client.raw, client.accountInfo, {
          bucketId: bucket.id,
          fileName: 'data.bin',
          source,
        }),
      ).rejects.toThrow(`FileSource file changed after validation: ${filePath}`)

      const unfinished = await client.raw.listUnfinishedLargeFiles(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id },
      )
      expect(unfinished.files).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
