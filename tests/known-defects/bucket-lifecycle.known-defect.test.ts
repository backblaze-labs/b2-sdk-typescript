// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

describe('bucket lifecycle rule read-modify-write known defects', () => {
  it('two concurrent addLifecycleRule calls never silently lose one rule', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    // Barrier: hold the first b2_list_buckets response until the second request
    // has been issued, so both callers read the same (stale) rule set.
    let listCalls = 0
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_list_buckets')) {
          listCalls++
          if (listCalls === 1) {
            const resp = await inner.send(req)
            await firstHeld
            return resp
          }
          const resp = await inner.send(req)
          releaseFirst()
          return resp
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport,
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'c12-lifecycle',
      bucketType: BucketType.AllPrivate,
    })
    listCalls = 0

    const results = await Promise.allSettled([
      bucket.addLifecycleRule({
        daysFromHidingToDeleting: 7,
        daysFromUploadingToHiding: null,
        fileNamePrefix: 'a/',
      }),
      bucket.addLifecycleRule({
        daysFromHidingToDeleting: 9,
        daysFromUploadingToHiding: null,
        fileNamePrefix: 'b/',
      }),
    ])

    const finalRules = await bucket.getLifecycleRules()
    const prefixes = finalRules.map((r) => r.fileNamePrefix).sort()
    const rejected = results.filter((r) => r.status === 'rejected').length
    // Acceptable outcomes: both rules present, or the losing writer was told
    // (a revision conflict). Silent loss of one rule is the defect.
    expect(
      prefixes.length === 2 || rejected >= 1,
      `final rules ${JSON.stringify(prefixes)} with ${rejected} rejected writer(s): one update was silently overwritten`,
    ).toBe(true)
  })
})
