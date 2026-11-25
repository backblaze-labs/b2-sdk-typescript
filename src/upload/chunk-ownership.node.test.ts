import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { toContentSource } from '../streams/source.ts'
import { makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'

const expected = new Uint8Array([1, 2, 3, 4])
const expectedSha1 = createHash('sha1').update(expected).digest('hex')

async function makeBucket() {
  const { client } = makeClient()
  await client.authorize()
  return client.createBucket({ bucketName: 'chunk-ownership', bucketType: BucketType.AllPrivate })
}

for (const kind of ['Uint8Array', 'Buffer'] as const) {
  describe(`caller-owned ${kind} chunks`, () => {
    const makeChunk = () =>
      kind === 'Buffer' ? Buffer.from([0, 1, 2, 0]).subarray(1, 3) : new Uint8Array([1, 2])

    it('preserves bytes after awaited writes when the caller reuses the buffer', async () => {
      const bucket = await makeBucket()
      const file = bucket.file('writable.bin')
      const { writable, done } = file.createWriteStream()
      const writer = writable.getWriter()
      const chunk = makeChunk()
      await writer.write(chunk)
      chunk.set([3, 4])
      await writer.write(chunk)
      chunk.fill(9)
      await writer.close()
      const result = await done
      const downloaded = await file.download()
      expect(await readStream(downloaded.body)).toEqual(expected)
      expect(result.contentSha1).toBe(expectedSha1)
    })

    it('preserves successive reads from a reused readable-stream buffer', async () => {
      const bucket = await makeBucket()
      const chunk = makeChunk()
      let reads = 0
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (reads === 2) {
              chunk.fill(9)
              controller.close()
              return
            }
            chunk.set(reads++ === 0 ? [1, 2] : [3, 4])
            controller.enqueue(chunk)
          },
        },
        { highWaterMark: 0 },
      )
      const result = await bucket.upload({
        fileName: 'readable.bin',
        source: toContentSource(stream, 4),
      })
      expect(await readStream((await bucket.file('readable.bin').download()).body)).toEqual(
        expected,
      )
      expect(result.contentSha1).toBe(expectedSha1)
    })

    it('preserves successive yields of a reused async-iterator buffer', async () => {
      const bucket = await makeBucket()
      const chunk = makeChunk()
      async function* source() {
        yield chunk
        chunk.set([3, 4])
        yield chunk
        chunk.fill(9)
      }
      const result = await bucket.upload({
        fileName: 'iterable.bin',
        source: toContentSource(source(), 4),
      })
      expect(await readStream((await bucket.file('iterable.bin').download()).body)).toEqual(
        expected,
      )
      expect(result.contentSha1).toBe(expectedSha1)
    })

    it('owns chunks queued by the async-iterator adapter before the next yield', async () => {
      const chunk = makeChunk()
      async function* source() {
        yield chunk
        chunk.set([3, 4])
        yield chunk
      }
      const reader = toContentSource(source(), 4).stream().getReader()
      const first = await reader.read()
      const second = await reader.read()
      expect(first.value).toEqual(new Uint8Array([1, 2]))
      expect(second.value).toEqual(new Uint8Array([3, 4]))
      await reader.cancel()
      reader.releaseLock()
    })
  })
}
