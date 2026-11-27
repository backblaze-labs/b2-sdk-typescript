import { describe, expect, it } from 'vitest'
import { B2Client } from './client.ts'
import { ConflictError } from './errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from './http/transport.ts'
import { resetRemoteSimulator } from './test-utils/remote-simulator.ts'
import { BucketType, type LifecycleRule } from './types/bucket.ts'

const rule = (fileNamePrefix: string): LifecycleRule => ({
  daysFromHidingToDeleting: 7,
  daysFromUploadingToHiding: null,
  fileNamePrefix,
})

describe('lifecycle rule revision conflicts', () => {
  for (const operation of ['add', 'remove'] as const) {
    it(`${operation} refetches after a conflicting update and preserves the other writer`, async () => {
      const sim = await resetRemoteSimulator()
      const inner = sim.transport()
      let injectConflict = false
      let updates = 0
      const transport: HttpTransport = {
        async send(req: HttpRequest): Promise<HttpResponse> {
          if (injectConflict && req.url.includes('b2_update_bucket')) {
            updates++
            if (updates === 1) {
              const original = JSON.parse(req.body as string) as Record<string, unknown>
              const other = await inner.send({
                ...req,
                body: JSON.stringify({
                  ...original,
                  lifecycleRules: [rule('old/'), rule('other/')],
                }),
              })
              expect(other.status).toBe(200)
            }
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
        bucketName: `c12-${operation}`,
        bucketType: BucketType.AllPrivate,
      })
      await bucket.setLifecycleRules([rule('old/')])
      injectConflict = true
      if (operation === 'add') await bucket.addLifecycleRule(rule('new/'))
      else await bucket.removeLifecycleRule('old/')
      expect(updates).toBe(2)
      expect((await bucket.getLifecycleRules()).map((r) => r.fileNamePrefix).sort()).toEqual(
        operation === 'add' ? ['new/', 'old/', 'other/'] : ['other/'],
      )
    })
  }

  it('stops after repeated revision conflicts and surfaces the conflict', async () => {
    const sim = await resetRemoteSimulator()
    const inner = sim.transport()
    let updates = 0
    const conflict = new ConflictError({
      status: 409,
      code: 'conflict',
      message: 'revision mismatch',
    })
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      realm: sim.realm,
      transport: {
        async send(req) {
          if (req.url.includes('b2_update_bucket')) {
            updates++
            throw conflict
          }
          return inner.send(req)
        },
      },
      retry: { maxRetries: 0 },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'c12-conflicts',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.addLifecycleRule(rule('new/'))).rejects.toBe(conflict)
    expect(updates).toBe(4)
  })
})
