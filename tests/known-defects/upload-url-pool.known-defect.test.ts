// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { deterministicBytes } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'
import { uploadLargeFile } from '../../src/upload/large.ts'

describe('part upload URL pool known defects', () => {
  it('part-upload URLs for a finished large file are not retained in the account pool', async () => {
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    // The pool is keyed by the large-file id issued by b2_start_large_file. The simulator
    // gives the finished file a different id, so read the key off the start request itself
    // instead of the returned FileVersion or any internal check-in call.
    const inner = sim.transport()
    let startedFileId: string | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const resp = await inner.send(req)
        if (req.url.includes('b2_start_large_file')) {
          startedFileId = ((await resp.json()) as { fileId: string }).fileId
        }
        return resp
      },
    }
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport,
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'pool-c13',
      bucketType: BucketType.AllPrivate,
    })

    const info = client.accountInfo
    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'pooled.bin',
      source: new BufferSource(deterministicBytes(300_000)),
      partSize: 100_000,
      concurrency: 2,
    })

    // The large file is finished; its per-file part-URL entries can never be
    // used again, so the pool must not keep them (otherwise it grows per file).
    // Whether the upload checked URLs in or never pooled them is an implementation
    // detail: only the absence of a retained entry is the contract.
    expect(startedFileId, 'b2_start_large_file was never issued').toBeDefined()
    const leaked = info.checkoutPartUploadUrl(startedFileId as string)
    expect(leaked, 'a part upload URL for a finished large file is still pooled').toBeNull()
  })
})
