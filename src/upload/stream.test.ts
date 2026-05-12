import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import { B2Simulator } from '../simulator/index.ts'

function makeClient(): { client: B2Client; sim: B2Simulator } {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.byteLength
  }
  return result
}

function deterministic(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

function chunkedReadable(data: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, data.byteLength)
      controller.enqueue(data.slice(offset, end))
      offset = end
    },
  })
}

describe('B2Object.createWriteStream', () => {
  let client: B2Client
  let bucket: Bucket

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({ bucketName: 'stream-upload', bucketType: 'allPrivate' })
  })

  it('pipes a chunked ReadableStream through createWriteStream and round-trips bytes', async () => {
    const total = 5_000_010
    const data = deterministic(total)
    const source = chunkedReadable(data, 128 * 1024)

    const { writable, done } = bucket.file('streamed.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 2,
    })

    await source.pipeTo(writable)
    const result = await done

    expect(result.fileName).toBe('streamed.bin')
    expect(result.contentLength).toBe(total)

    const dl = await bucket.download('streamed.bin')
    const got = await readStream(dl.body)
    expect(got).toEqual(data)
  }, 30_000)

  it('invokes the onProgress listener as parts complete', async () => {
    const data = deterministic(5_000_010)
    const events: { bytesTransferred: number; partsCompleted: number }[] = []
    const { writable, done } = bucket.file('progress.bin').createWriteStream({
      partSize: 5_000_000,
      concurrency: 1,
      onProgress: (e) => {
        events.push({ bytesTransferred: e.bytesTransferred, partsCompleted: e.partsCompleted })
      },
    })

    await chunkedReadable(data, 128 * 1024).pipeTo(writable)
    await done

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.bytesTransferred).toBe(data.byteLength)
    expect(last?.partsCompleted).toBe(2)
  }, 30_000)

  it('rejects when the writable is closed without any data', async () => {
    const { writable, done } = bucket.file('empty.bin').createWriteStream({
      partSize: 5_000_000,
    })

    const writer = writable.getWriter()
    // Both the writer.close() promise and the `done` promise reject. Attach a
    // handler to both to avoid unhandled rejection noise.
    const closePromise = writer.close().catch(() => {})
    await closePromise
    await expect(done).rejects.toThrow(/without any data/)
  })

  it('abort cancels the unfinished large file and rejects done', async () => {
    const controller = new AbortController()
    const { writable, done } = bucket.file('aborted.bin').createWriteStream({
      partSize: 5_000_000,
      signal: controller.signal,
    })

    // Pump a tiny bit of data, then abort before close.
    const writer = writable.getWriter()
    await writer.write(new Uint8Array(100))
    controller.abort()
    try {
      await writer.close()
    } catch {
      // expected
    }
    await expect(done).rejects.toBeDefined()

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    // The large file may or may not have been started before abort fired;
    // either way it should not remain unfinished.
    expect(unfinished.files.find((f) => f.fileName === 'aborted.bin')).toBeUndefined()
  }, 30_000)
})
