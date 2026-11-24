import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { B2Client } from '../client.ts'
import { type HttpRequest, type HttpResponse, RetryTransport } from '../http/transport.ts'
import { RawClient } from '../raw/index.ts'
import { B2Simulator } from '../simulator/index.ts'
import { readStream } from '../test-utils/index.ts'
import { fileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

describe('parallel range response body resets', () => {
  it('retries only the interrupted range and emits the original bytes exactly once', async () => {
    const data = Uint8Array.from({ length: 30 }, (_, index) => index)
    const attempts = new Map<string, number>()
    let partialChunkRead = false
    const transport = new RetryTransport({
      transport: {
        async send(request: HttpRequest): Promise<HttpResponse> {
          const range = request.headers?.['Range'] ?? ''
          const match = /^bytes=(\d+)-(\d+)$/.exec(range)
          if (match === null) throw new Error(`Unexpected range ${range}`)
          const start = Number(match[1])
          const end = Number(match[2])
          const count = (attempts.get(range) ?? 0) + 1
          attempts.set(range, count)
          const bytes = data.slice(start, end + 1)
          let pulls = 0
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              if (range === 'bytes=10-19' && count === 1) {
                if (pulls === 1) {
                  partialChunkRead = true
                  controller.enqueue(bytes.slice(0, 4))
                } else {
                  controller.error(new TypeError('Connection reset while reading response body'))
                }
              } else {
                controller.enqueue(bytes)
                controller.close()
              }
            },
          })
          return {
            status: 206,
            headers: new Headers({ 'Content-Range': `bytes ${start}-${end}/${data.length}` }),
            body,
            json: () => Promise.reject(new Error('Not JSON')),
            text: () => Promise.reject(new Error('Not text')),
            arrayBuffer: () => Promise.reject(new Error('Not buffered')),
          }
        },
      },
      retry: { maxRetries: 1, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      sleepImpl: async () => {},
    })
    const raw = new RawClient({ transport })
    const accountInfo = {
      getDownloadUrl: () => 'https://download.example.test',
      getAuthToken: () => 'test-token',
    } as unknown as AccountInfo
    const stream = createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: data.length,
      rangeSize: 10,
      concurrency: 2,
    })

    expect(await readStream(stream)).toEqual(data)
    expect(partialChunkRead).toBe(true)
    expect(Object.fromEntries(attempts)).toEqual({
      'bytes=0-9': 1,
      'bytes=10-19': 2,
      'bytes=20-29': 1,
    })
  })

  it.each([0, 1, 2])('honors the client retry budget of %i for body resets', async (maxRetries) => {
    const data = Uint8Array.from([1, 2, 3, 4, 5, 6])
    const simulator = new B2Simulator()
    const inner = simulator.transport()
    let attempts = 0
    const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      retry: { maxRetries, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
      transport: {
        async send(request) {
          if (!request.url.includes('b2_download_file_by_id')) return inner.send(request)
          attempts++
          const shouldFail = maxRetries === 2 || attempts === 1
          let pulls = 0
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls++
              if (shouldFail && pulls === 1) controller.enqueue(data.slice(0, 2))
              else if (shouldFail) controller.error(reset)
              else {
                controller.enqueue(data)
                controller.close()
              }
            },
          })
          return {
            status: 206,
            headers: new Headers({ 'Content-Range': 'bytes 0-5/6' }),
            body,
            json: () => Promise.reject(new Error('Not JSON')),
            text: () => Promise.reject(new Error('Not text')),
            arrayBuffer: () => Promise.reject(new Error('Not buffered')),
          }
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'range-reset',
      bucketType: 'allPrivate',
    })
    const stream = bucket.file('example').createReadStream(fileId('file'), data.length, {
      rangeSize: data.length,
      concurrency: 1,
    })

    if (maxRetries === 1) {
      expect(await readStream(stream)).toEqual(data)
      expect(attempts).toBe(2)
    } else {
      await expect(readStream(stream)).rejects.toBe(reset)
      expect(attempts).toBe(maxRetries + 1)
    }
  })

  it('does not retry a body error explicitly marked non-retryable', async () => {
    const failure = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
      retryable: false,
    })
    let attempts = 0
    const raw = new RawClient({
      transport: {
        async send() {
          attempts++
          return {
            status: 206,
            headers: new Headers({ 'Content-Range': 'bytes 0-0/1' }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(failure)
              },
            }),
            json: () => Promise.reject(new Error('Not JSON')),
            text: () => Promise.reject(new Error('Not text')),
            arrayBuffer: () => Promise.reject(new Error('Not buffered')),
          }
        },
      },
    })
    const accountInfo = {
      getDownloadUrl: () => 'https://download.example.test',
      getAuthToken: () => 'test-token',
    } as unknown as AccountInfo

    const stream = createParallelDownloadStream(raw, accountInfo, {
      fileId: fileId('example-file'),
      totalSize: 1,
      maxRetries: 1,
      bodyRetryOptions: { maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    })
    await expect(readStream(stream)).rejects.toBe(failure)
    expect(attempts).toBe(1)
  })
})
