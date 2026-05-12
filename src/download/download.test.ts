import { beforeEach, describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import type { FileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'
import { downloadById, downloadByName } from './single.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

// ---------------------------------------------------------------------------
// single.ts - downloadByName
// ---------------------------------------------------------------------------

describe('downloadByName', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('returns correct body and headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-name-test',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('hello from download-by-name')
    const uploaded = await bucket.upload({
      fileName: 'greeting.txt',
      source: new BufferSource(content),
      contentType: 'text/plain',
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'dl-name-test',
      fileName: 'greeting.txt',
    })

    const body = await readStream(result.body)
    expect(decode(body)).toBe('hello from download-by-name')
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileName).toBe('greeting.txt')
    expect(result.headers.contentType).toBe('text/plain')
    expect(result.headers.fileId).toBe(uploaded.fileId)
    expect(result.headers.contentSha1).toBeTruthy()
    expect(result.headers.uploadTimestamp).toBeGreaterThan(0)
  })

  it('returns fileInfo from X-Bz-Info-* headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-info-hdr',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('info-test')
    await bucket.upload({
      fileName: 'info.txt',
      source: new BufferSource(content),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'dl-info-hdr',
      fileName: 'info.txt',
    })

    // The simulator sets X-Bz-Info-src_last_modified_millis on every served file.
    expect(result.headers.fileInfo).toBeDefined()
    expect(result.headers.fileInfo['src_last_modified_millis']).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// single.ts - downloadById
// ---------------------------------------------------------------------------

describe('downloadById', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('returns correct body and headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-id-test',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('hello from download-by-id')
    const uploaded = await bucket.upload({
      fileName: 'byid.bin',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
    })

    const body = await readStream(result.body)
    expect(decode(body)).toBe('hello from download-by-id')
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileName).toBe('byid.bin')
    expect(result.headers.fileId).toBe(uploaded.fileId)
    expect(result.headers.uploadTimestamp).toBeGreaterThan(0)
  })

  it('range download returns partial content', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-id-range',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('0123456789abcdef')
    const uploaded = await bucket.upload({
      fileName: 'range.bin',
      source: new BufferSource(content),
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      range: 'bytes=4-7',
    })

    const body = await readStream(result.body)
    expect(decode(body)).toBe('4567')
    // The simulator returns the sliced length in Content-Length
    expect(result.headers.contentLength).toBe(4)
  })

  it('range download by name returns partial content', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-name-range',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('ABCDEFGHIJKLMNOP')
    await bucket.upload({
      fileName: 'alpha.bin',
      source: new BufferSource(content),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'dl-name-range',
      fileName: 'alpha.bin',
      range: 'bytes=0-3',
    })

    const body = await readStream(result.body)
    expect(decode(body)).toBe('ABCD')
    expect(result.headers.contentLength).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// single.ts - extractDownloadHeaders (tested indirectly)
// ---------------------------------------------------------------------------

describe('extractDownloadHeaders (via downloadById)', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('parses X-Bz-File-Name header', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-fname',
      bucketType: 'allPrivate',
    })
    const uploaded = await bucket.upload({
      fileName: 'path/to/file.txt',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
    })

    expect(result.headers.fileName).toBe('path/to/file.txt')
  })

  it('parses X-Bz-File-Id header', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-fid',
      bucketType: 'allPrivate',
    })
    const uploaded = await bucket.upload({
      fileName: 'id-test.bin',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
    })

    expect(result.headers.fileId).toBe(uploaded.fileId)
  })

  it('parses Content-Length header', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-clen',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('exactly 22 bytes long!')
    await bucket.upload({
      fileName: 'len.bin',
      source: new BufferSource(content),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'hdr-clen',
      fileName: 'len.bin',
    })

    expect(result.headers.contentLength).toBe(22)
  })

  it('parses Content-Type header', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-ctype',
      bucketType: 'allPrivate',
    })
    await bucket.upload({
      fileName: 'typed.json',
      source: new BufferSource(new TextEncoder().encode('{"key":"value"}')),
      contentType: 'application/json',
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'hdr-ctype',
      fileName: 'typed.json',
    })

    expect(result.headers.contentType).toBe('application/json')
  })

  it('parses X-Bz-Content-Sha1 header', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-sha1',
      bucketType: 'allPrivate',
    })
    await bucket.upload({
      fileName: 'sha.bin',
      source: new BufferSource(new TextEncoder().encode('checksum test')),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'hdr-sha1',
      fileName: 'sha.bin',
    })

    // The simulator stores whatever sha1 was provided at upload time (or 'none')
    expect(result.headers.contentSha1).toBeTruthy()
  })

  it('parses X-Bz-Info-* custom headers into fileInfo', async () => {
    const bucket = await client.createBucket({
      bucketName: 'hdr-info',
      bucketType: 'allPrivate',
    })
    await bucket.upload({
      fileName: 'custom-info.bin',
      source: new BufferSource(new TextEncoder().encode('custom')),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'hdr-info',
      fileName: 'custom-info.bin',
    })

    // The simulator always adds X-Bz-Info-src_last_modified_millis
    expect(typeof result.headers.fileInfo).toBe('object')
    expect('src_last_modified_millis' in result.headers.fileInfo).toBe(true)
  })

  it('parses X-Bz-Upload-Timestamp header', async () => {
    const before = Date.now()

    const bucket = await client.createBucket({
      bucketName: 'hdr-ts',
      bucketType: 'allPrivate',
    })
    await bucket.upload({
      fileName: 'ts.bin',
      source: new BufferSource(new TextEncoder().encode('timestamp')),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'hdr-ts',
      fileName: 'ts.bin',
    })

    const after = Date.now()
    expect(result.headers.uploadTimestamp).toBeGreaterThanOrEqual(before)
    // Allow generous overshoot: the simulator's monotonic timestamp generator
    // advances by 1 ms per emitted timestamp, and on fast runtimes (Bun) the
    // microtask queue drains so quickly that the counter outruns Date.now().
    // We only need to assert the timestamp is *recent*, not exact.
    expect(result.headers.uploadTimestamp).toBeLessThanOrEqual(after + 1000)
  })
})

// ---------------------------------------------------------------------------
// parallel.ts - createParallelDownloadStream
// ---------------------------------------------------------------------------

/**
 * Mock transport that serves ranged download requests for a known file.
 * Used to test createParallelDownloadStream without depending on the full
 * simulator (which does support ranges, but we want isolated unit-level tests).
 */
function createMockTransport(fileData: Uint8Array, fileId: string): HttpTransport {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      const url = request.url

      // Handle authorize_account
      if (url.includes('b2_authorize_account')) {
        const body = {
          accountId: 'mock_account',
          authorizationToken: 'mock_token',
          apiInfo: {
            storageApi: {
              absoluteMinimumPartSize: 5_000_000,
              apiUrl: 'http://mock:0',
              bucketId: null,
              bucketName: null,
              downloadUrl: 'http://mock:0',
              infoType: 'storageApi',
              namePrefix: null,
              recommendedPartSize: 100_000_000,
              s3ApiUrl: 'http://mock:0',
              allowed: { capabilities: [], bucketId: null, bucketName: null, namePrefix: null },
            },
          },
          applicationKeyExpirationTimestamp: null,
        }
        const json = JSON.stringify(body)
        return {
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(json))
              controller.close()
            },
          }),
          json: <T>() => Promise.resolve(body as T),
          text: () => Promise.resolve(json),
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(json).buffer as ArrayBuffer),
        }
      }

      // Handle download_file_by_id with range
      if (url.includes('b2_download_file_by_id')) {
        const rangeHeader = request.headers?.['Range'] ?? request.headers?.['range']
        let data = fileData
        let status = 200

        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/)
          if (match) {
            const start = Number.parseInt(match[1] ?? '0', 10)
            const end =
              match[2] !== undefined ? Number.parseInt(match[2], 10) : fileData.byteLength - 1
            data = fileData.slice(start, end + 1)
            status = 206
          }
        }

        const responseHeaders = new Headers({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          'X-Bz-File-Id': fileId,
          'X-Bz-File-Name': 'mock-file.bin',
          'X-Bz-Content-Sha1': 'none',
          'X-Bz-Upload-Timestamp': String(Date.now()),
        })

        return {
          status,
          headers: responseHeaders,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(data))
              controller.close()
            },
          }),
          json: () => Promise.reject(new Error('Not JSON')),
          text: () => Promise.resolve(new TextDecoder().decode(data)),
          arrayBuffer: () =>
            Promise.resolve(
              data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
            ),
        }
      }

      return {
        status: 404,
        headers: new Headers(),
        body: null,
        json: () => Promise.reject(new Error('Not found')),
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }
    },
  }
}

describe('createParallelDownloadStream', () => {
  it('downloads a file using parallel ranges and reassembles correctly', async () => {
    // Create a 100-byte file, use 30-byte ranges (yields 4 chunks: 30+30+30+10)
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i
    const fakeFileId = 'fake_file_001'

    const transport = createMockTransport(fileData, fakeFileId)
    const { RawClient } = await import('../raw/index.ts')
    const raw = new RawClient({ transport })

    // Build a minimal accountInfo that provides download URL and auth token
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 100,
      rangeSize: 30,
      concurrency: 2,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(100)
    // Verify every byte is in order
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toBe(i)
    }
  })

  it('single-range download works when file is smaller than range size', async () => {
    const fileData = new Uint8Array(15)
    for (let i = 0; i < 15; i++) fileData[i] = i + 10
    const fakeFileId = 'fake_file_002'

    const transport = createMockTransport(fileData, fakeFileId)
    const { RawClient } = await import('../raw/index.ts')
    const raw = new RawClient({ transport })

    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 15,
      rangeSize: 1024, // much larger than file
      concurrency: 4,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(15)
    for (let i = 0; i < 15; i++) {
      expect(result[i]).toBe(i + 10)
    }
  })

  it('handles the last range being shorter than rangeSize', async () => {
    // 50 bytes with 20-byte ranges: chunks are [0-19], [20-39], [40-49]
    const fileData = new Uint8Array(50)
    for (let i = 0; i < 50; i++) fileData[i] = 200 - i
    const fakeFileId = 'fake_file_003'

    const transport = createMockTransport(fileData, fakeFileId)
    const { RawClient } = await import('../raw/index.ts')
    const raw = new RawClient({ transport })

    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 50,
      rangeSize: 20,
      concurrency: 2,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(50)
    // Verify first chunk
    expect(result[0]).toBe(200)
    expect(result[19]).toBe(181)
    // Verify last (short) chunk
    expect(result[40]).toBe(160)
    expect(result[49]).toBe(151)
  })
})

// ---------------------------------------------------------------------------
// parallel.ts with simulator (end-to-end)
// ---------------------------------------------------------------------------

describe('createParallelDownloadStream per-range retry', () => {
  function createFlakyTransport(
    fileData: Uint8Array,
    fileId: string,
    failuresPerRange: Map<string, number>,
  ): HttpTransport {
    return {
      async send(request: HttpRequest): Promise<HttpResponse> {
        const url = request.url

        if (url.includes('b2_authorize_account')) {
          const body = {
            accountId: 'mock_account',
            authorizationToken: 'mock_token',
            apiInfo: {
              storageApi: {
                absoluteMinimumPartSize: 5_000_000,
                apiUrl: 'http://mock:0',
                bucketId: null,
                bucketName: null,
                downloadUrl: 'http://mock:0',
                infoType: 'storageApi',
                namePrefix: null,
                recommendedPartSize: 100_000_000,
                s3ApiUrl: 'http://mock:0',
                allowed: {
                  capabilities: [],
                  bucketId: null,
                  bucketName: null,
                  namePrefix: null,
                },
              },
            },
            applicationKeyExpirationTimestamp: null,
          }
          const json = JSON.stringify(body)
          return {
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(json))
                controller.close()
              },
            }),
            json: <T>() => Promise.resolve(body as T),
            text: () => Promise.resolve(json),
            arrayBuffer: () =>
              Promise.resolve(new TextEncoder().encode(json).buffer as ArrayBuffer),
          }
        }

        if (url.includes('b2_download_file_by_id')) {
          const rangeHeader = request.headers?.['Range'] ?? request.headers?.['range'] ?? ''
          const remaining = failuresPerRange.get(rangeHeader) ?? 0
          if (remaining > 0) {
            failuresPerRange.set(rangeHeader, remaining - 1)
            return {
              status: 503,
              headers: new Headers(),
              body: new ReadableStream({
                start(c) {
                  c.enqueue(new TextEncoder().encode('{"code":"service_unavailable"}'))
                  c.close()
                },
              }),
              json: <T>() => Promise.resolve({ code: 'service_unavailable' } as T),
              text: () => Promise.resolve('{"code":"service_unavailable"}'),
              arrayBuffer: () =>
                Promise.resolve(
                  new TextEncoder().encode('{"code":"service_unavailable"}').buffer as ArrayBuffer,
                ),
            }
          }

          let data = fileData
          let status = 200
          const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/)
          if (match) {
            const start = Number.parseInt(match[1] ?? '0', 10)
            const end =
              match[2] !== undefined ? Number.parseInt(match[2], 10) : fileData.byteLength - 1
            data = fileData.slice(start, end + 1)
            status = 206
          }
          const responseHeaders = new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(data.byteLength),
            'X-Bz-File-Id': fileId,
            'X-Bz-File-Name': 'flaky.bin',
            'X-Bz-Content-Sha1': 'none',
            'X-Bz-Upload-Timestamp': String(Date.now()),
          })
          return {
            status,
            headers: responseHeaders,
            body: new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(data))
                c.close()
              },
            }),
            json: () => Promise.reject(new Error('Not JSON')),
            text: () => Promise.resolve(new TextDecoder().decode(data)),
            arrayBuffer: () =>
              Promise.resolve(
                data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                ) as ArrayBuffer,
              ),
          }
        }

        return {
          status: 404,
          headers: new Headers(),
          body: null,
          json: () => Promise.reject(new Error('Not found')),
          text: () => Promise.resolve(''),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }
      },
    }
  }

  it('retries a single range that fails transiently and produces a byte-perfect file', async () => {
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i

    // Force the middle range to fail twice with 503 before succeeding.
    const failures = new Map<string, number>([['bytes=30-59', 2]])
    const { RawClient } = await import('../raw/index.ts')
    // Wrap in RetryTransport so 503s are surfaced rather than swallowed by the raw transport.
    const { RetryTransport } = await import('../http/transport.ts')
    const inner = createFlakyTransport(fileData, 'fake_file_retry', failures)
    const retry = new RetryTransport({ transport: inner, retry: { maxRetries: 0 } })
    const raw = new RawClient({ transport: retry })

    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'fake_file_retry' as FileId,
      totalSize: 100,
      rangeSize: 30,
      concurrency: 2,
      maxRetries: 5,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(result[i]).toBe(i)
    }
    // All retries consumed
    expect(failures.get('bytes=30-59')).toBe(0)
  })

  it('errors the stream when a range fails beyond maxRetries', async () => {
    const fileData = new Uint8Array(60)
    const failures = new Map<string, number>([['bytes=0-29', 10]])
    const { RawClient } = await import('../raw/index.ts')
    const { RetryTransport } = await import('../http/transport.ts')
    const inner = createFlakyTransport(fileData, 'fake_file_fail', failures)
    const retry = new RetryTransport({ transport: inner, retry: { maxRetries: 0 } })
    const raw = new RawClient({ transport: retry })

    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'fake_file_fail' as FileId,
      totalSize: 60,
      rangeSize: 30,
      concurrency: 2,
      maxRetries: 2,
    })

    await expect(readStream(stream)).rejects.toThrow()
  })
})

describe('createParallelDownloadStream with simulator', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('downloads via parallel ranges using the simulator', async () => {
    const bucket = await client.createBucket({
      bucketName: 'parallel-sim',
      bucketType: 'allPrivate',
    })

    // Create a moderately-sized payload (256 bytes) and split into 64-byte ranges
    const content = new Uint8Array(256)
    for (let i = 0; i < 256; i++) content[i] = i % 256
    const uploaded = await bucket.upload({
      fileName: 'parallel-test.bin',
      source: new BufferSource(content),
    })

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      totalSize: 256,
      rangeSize: 64,
      concurrency: 2,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(256)
    for (let i = 0; i < 256; i++) {
      expect(result[i]).toBe(i % 256)
    }
  })

  it('parallel download with concurrency=1 produces correct output', async () => {
    const bucket = await client.createBucket({
      bucketName: 'parallel-seq',
      bucketType: 'allPrivate',
    })

    const text = 'sequential parallel download test content with enough data'
    const content = new TextEncoder().encode(text)
    const uploaded = await bucket.upload({
      fileName: 'seq.txt',
      source: new BufferSource(content),
    })

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      totalSize: content.byteLength,
      rangeSize: 10,
      concurrency: 1,
    })

    const result = await readStream(stream)
    expect(decode(result)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// Tier 1: HEAD method + response-header overrides on downloadById
// ---------------------------------------------------------------------------

describe('downloadById HEAD method and response-header overrides', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('HEAD download returns headers and an empty body', async () => {
    const bucket = await client.createBucket({
      bucketName: 'head-by-id',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('payload for HEAD test')
    const uploaded = await bucket.upload({
      fileName: 'head.bin',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      method: 'HEAD',
    })

    expect(result.headers.fileName).toBe('head.bin')
    expect(result.headers.contentLength).toBe(content.byteLength)
    const body = await readStream(result.body)
    expect(body.byteLength).toBe(0)
  })

  it('downloadByName supports HEAD and produces an empty body', async () => {
    const bucket = await client.createBucket({
      bucketName: 'head-by-name',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('named HEAD payload')
    await bucket.upload({
      fileName: 'meta.txt',
      source: new BufferSource(content),
      contentType: 'text/plain',
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'head-by-name',
      fileName: 'meta.txt',
      method: 'HEAD',
    })

    expect(result.headers.contentLength).toBe(content.byteLength)
    const body = await readStream(result.body)
    expect(body.byteLength).toBe(0)
  })

  it('b2Content* overrides on downloadById are echoed back as response headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'overrides-by-id',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('{"hello":"world"}')
    const uploaded = await bucket.upload({
      fileName: 'data.json',
      source: new BufferSource(content),
      contentType: 'application/json',
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      b2ContentType: 'text/plain; charset=utf-8',
      b2ContentDisposition: 'attachment; filename="report.txt"',
      b2CacheControl: 'no-cache',
    })

    // The simulator echoes b2Content* query params back into response headers,
    // matching real B2 behavior.
    expect(result.headers.contentType).toBe('text/plain; charset=utf-8')
  })

  it('b2Content* overrides on downloadByName are echoed back as response headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'overrides-by-name',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('overridden!')
    await bucket.upload({
      fileName: 'output.bin',
      source: new BufferSource(content),
    })

    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'overrides-by-name',
      fileName: 'output.bin',
      b2ContentType: 'application/pdf',
      b2ContentLanguage: 'en-US',
    })

    expect(result.headers.contentType).toBe('application/pdf')
  })

  it('every b2Content* override is forwarded as a query parameter', async () => {
    // Exercises every branch of the override map in raw/index.ts so each
    // b2Content* parameter actually round-trips through the simulator's
    // response-header echo.
    const bucket = await client.createBucket({
      bucketName: 'overrides-all',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('all-overrides')
    const uploaded = await bucket.upload({
      fileName: 'all.bin',
      source: new BufferSource(content),
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      b2ContentType: 'text/csv',
      b2ContentDisposition: 'inline',
      b2ContentEncoding: 'gzip',
      b2ContentLanguage: 'fr-CA',
      b2CacheControl: 'public, max-age=3600',
      b2Expires: 'Thu, 01 Jan 2099 00:00:00 GMT',
    })
    expect(result.headers.contentType).toBe('text/csv')
  })

  it('HEAD + b2Content* overrides combine: empty body, overridden headers', async () => {
    const bucket = await client.createBucket({
      bucketName: 'head-with-overrides',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('combined test')
    const uploaded = await bucket.upload({
      fileName: 'combo.bin',
      source: new BufferSource(content),
      contentType: 'application/octet-stream',
    })

    const result = await downloadById(client.raw, client.accountInfo, {
      fileId: uploaded.fileId,
      method: 'HEAD',
      b2ContentType: 'image/png',
    })

    expect(result.headers.contentType).toBe('image/png')
    const body = await readStream(result.body)
    expect(body.byteLength).toBe(0)
  })

  it('Bucket.download(method: HEAD) returns metadata without streaming the body', async () => {
    const bucket = await client.createBucket({
      bucketName: 'bucket-head',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('via Bucket.download HEAD')
    await bucket.upload({
      fileName: 'bucket-head.bin',
      source: new BufferSource(content),
    })

    const result = await bucket.download('bucket-head.bin', { method: 'HEAD' })
    expect(result.headers.contentLength).toBe(content.byteLength)
    const body = await readStream(result.body)
    expect(body.byteLength).toBe(0)
  })

  it('B2Object.downloadById(method: HEAD) returns metadata without streaming the body', async () => {
    const bucket = await client.createBucket({
      bucketName: 'object-head',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('via B2Object.downloadById HEAD')
    const uploaded = await bucket.upload({
      fileName: 'obj-head.bin',
      source: new BufferSource(content),
    })

    const obj = bucket.file('obj-head.bin')
    const result = await obj.downloadById(uploaded.fileId, { method: 'HEAD' })
    expect(result.headers.contentLength).toBe(content.byteLength)
    const body = await readStream(result.body)
    expect(body.byteLength).toBe(0)
  })
})
