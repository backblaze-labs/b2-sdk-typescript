// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { deterministicBytes } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'
import { uploadLargeFile } from '../../src/upload/large.ts'

describe('part upload URL pool known defects', () => {
  it('part-upload URLs for a finished large file are not retained in the account pool', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'pool-c13',
      bucketType: BucketType.AllPrivate,
    })

    // Record which per-file keys the upload checks part URLs in under.
    const keys = new Set<string>()
    const info = client.accountInfo
    const originalReturn = info.returnPartUploadUrl.bind(info)
    info.returnPartUploadUrl = (fileId, entry) => {
      keys.add(fileId)
      originalReturn(fileId, entry)
    }

    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'pooled.bin',
      source: new BufferSource(deterministicBytes(300_000)),
      partSize: 100_000,
      concurrency: 2,
    })

    // The large file is finished; its per-file part-URL entries can never be
    // used again, so the pool must not keep them (otherwise it grows per file).
    expect(keys.size, 'precondition: exactly one pooled upload URL key').toBe(1)
    for (const key of keys) {
      const leaked = info.checkoutPartUploadUrl(key)
      expect(leaked, 'a part upload URL for a finished large file is still pooled').toBeNull()
    }
  })
})
