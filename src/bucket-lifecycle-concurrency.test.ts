import { describe, expect, it } from 'vitest'
import { B2Client } from './client.ts'
import { ConflictError } from './errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from './http/transport.ts'
import { resetRemoteSimulator } from './test-utils/remote-simulator.ts'
import { BucketType } from './types/bucket.ts'

describe('bucket lifecycle rule concurrent updates', () => {
  it('two concurrent addLifecycleRule calls never silently lose one rule', async () => {
    const sim = await resetRemoteSimulator()
    const inner = sim.transport()
    // Barrier: hold the first b2_list_buckets response until the second request
    // has been issued, so both callers read the same (stale) rule set. A correct
    // implementation that serializes the calls never issues the second read while
    // the first is held, so the hold is released by a bounded fallback timer too.
    let listCalls = 0
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fallback = setTimeout(() => releaseFirst(), 500)
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
      realm: sim.realm,
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

    clearTimeout(fallback)

    const finalRules = await bucket.getLifecycleRules()
    const prefixes = finalRules.map((r) => r.fileNamePrefix).sort()
    const expected = [
      { prefix: 'a/', result: results[0] },
      { prefix: 'b/', result: results[1] },
    ]
    // A rejected writer is acceptable only if it was told about a revision
    // conflict; any other error is an unrelated failure.
    for (const { result } of expected) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(ConflictError)
        expect((result.reason as ConflictError).status).toBe(409)
      }
    }
    const fulfilled = expected.filter((e) => e.result.status === 'fulfilled')
    expect(fulfilled.length, 'at least one writer must succeed').toBeGreaterThanOrEqual(1)
    // Silent loss of a fulfilled writer's rule is the defect.
    for (const { prefix } of fulfilled) {
      expect(prefixes, `rule ${prefix} was reported saved but is missing`).toContain(prefix)
    }
    if (fulfilled.length === 2) expect(prefixes).toEqual(['a/', 'b/'])
  })
})
