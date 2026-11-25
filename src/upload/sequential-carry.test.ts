import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { sha1Hex } from '../streams/hash.ts'
import { StreamSource } from '../streams/source.ts'
import { readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { uploadLargeFile } from './large.ts'

describe('sequential multipart source ownership', () => {
  it('preserves carried bytes when the producer reuses a boundary-spanning buffer', async () => {
    const sim = new B2Simulator({ minimumPartSize: 4, recommendedPartSize: 4 })
    const inner = sim.transport()
    let release: () => void = () => {}
    const uploadedFirst = new Promise<void>((resolve) => {
      release = resolve
    })
    const parts: { bytes: number[]; sha1: string | undefined }[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        if (req.url.includes('b2_upload_part')) {
          const bytes = new Uint8Array(await new Response(req.body).arrayBuffer())
          parts.push({
            bytes: Array.from(bytes),
            sha1: new Headers(req.headers).get('x-bz-content-sha1') ?? undefined,
          })
          if (parts.length === 1) release()
        }
        return inner.send(req)
      },
    }
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport,
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'carry-reuse',
      bucketType: BucketType.AllPrivate,
    })
    const shared = new Uint8Array([1, 2, 3, 4, 5, 6])
    let count = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (count++ === 0) {
          controller.enqueue(shared)
          return
        }
        await uploadedFirst
        shared.set([7, 8, 9, 10, 11, 12])
        controller.enqueue(shared)
        controller.close()
      },
    })
    const result = await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'bytes.bin',
      source: new StreamSource(stream, 12),
      partSize: 4,
    })
    const expected = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ]
    expect(parts.map((part) => part.bytes)).toEqual(expected)
    expect(parts.map((part) => part.sha1)).toEqual(
      await Promise.all(expected.map((part) => sha1Hex(new Uint8Array(part)))),
    )
    const downloaded = await bucket.file('bytes.bin').downloadById(result.fileId)
    expect(Array.from(await readStream(downloaded.body))).toEqual(expected.flat())
  })
})
