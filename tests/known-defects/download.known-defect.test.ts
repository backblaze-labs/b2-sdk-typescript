// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../../src/test-utils/index.ts'
import { BucketType } from '../../src/types/bucket.ts'

async function setup(size: number) {
  const { client } = makeClient()
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'download-kd',
    bucketType: BucketType.AllPrivate,
  })
  const data = deterministicBytes(size)
  const uploaded = await bucket.upload({ fileName: 'f.bin', source: new BufferSource(data) })
  return { bucket, data, uploaded }
}

describe('parallel download known defects', () => {
  it('concurrency 0 must not silently end with zero bytes', async () => {
    const { bucket, data, uploaded } = await setup(100)
    const obj = bucket.file('f.bin')

    let outcome: { bytes: Uint8Array } | { error: unknown }
    try {
      outcome = {
        bytes: await readStream(
          obj.createReadStream(uploaded.fileId, data.byteLength, { rangeSize: 25, concurrency: 0 }),
        ),
      }
    } catch (error) {
      outcome = { error }
    }

    // Correct behaviour: either reject the invalid option, or deliver the whole file.
    if ('bytes' in outcome) {
      expect(outcome.bytes, 'download with concurrency 0 returned different bytes').toEqual(data)
    } else {
      expect(outcome.error).toBeInstanceOf(Error)
    }
  })

  it('a connection reset mid-body on one range must not abort the download by default', async () => {
    const data = deterministicBytes(100)
    const { sim } = makeClient()
    const ranges: string[] = []
    const inner = sim.transport()
    const flaky: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const resp = await inner.send(req)
        const range = req.headers?.['Range'] ?? req.headers?.['range']
        if (range !== undefined && resp.status === 206) {
          ranges.push(range)
          if (ranges.length === 1) {
            const full = new Uint8Array(await resp.arrayBuffer())
            // Pull-driven (highWaterMark 0): the first pull hands the consumer five
            // bytes, and the reset is raised on the next pull, i.e. after the reader
            // has already received that chunk (erroring in start() would discard it).
            let pulls = 0
            const body = new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls++
                  if (pulls === 1) controller.enqueue(full.slice(0, 5))
                  else controller.error(new TypeError('terminated: connection reset'))
                },
              },
              { highWaterMark: 0 },
            )
            return {
              ...resp,
              body,
              json: resp.json,
              text: resp.text,
              arrayBuffer: resp.arrayBuffer,
            }
          }
        }
        return resp
      },
    }
    // Rebuild a client over the flaky transport sharing the same simulator state.
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: flaky,
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'dl-reset',
      bucketType: BucketType.AllPrivate,
    })
    const uploaded = await bucket.upload({ fileName: 'f.bin', source: new BufferSource(data) })

    const got = await readStream(
      bucket.file('f.bin').createReadStream(uploaded.fileId, data.byteLength, {
        rangeSize: 50,
        concurrency: 1,
      }),
    )

    // The first request is the 50-byte range that was cut off after 5 bytes. It must be
    // requested again, either whole or resumed from byte 5, never skipped.
    expect(ranges[0], 'first ranged request').toBe('bytes=0-49')
    expect(
      ranges.slice(1).some((r) => r === 'bytes=0-49' || r === 'bytes=5-49'),
      `the failed range was not requested again; ranged requests: ${JSON.stringify(ranges)}`,
    ).toBe(true)
    expect(got, 'downloaded bytes differ from the stored file').toEqual(data)
  })
})
