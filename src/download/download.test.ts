import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { B2Client } from '../client.ts'
import { ChecksumMismatchError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { RawClient } from '../raw/index.ts'
import { sha1Hex } from '../streams/hash.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient, readStream } from '../test-utils/index.ts'
import type { FileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'
import { downloadById, downloadByName, headById, headByName } from './single.ts'

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

function headResponseHeaders(fileName = 'head.txt'): Headers {
  return new Headers({
    'Content-Length': '0',
    'Content-Type': 'text/plain',
    'X-Bz-Content-Sha1': 'none',
    'X-Bz-File-Id': 'head-file-id',
    'X-Bz-File-Name': encodeURIComponent(fileName),
    'X-Bz-Upload-Timestamp': '1000',
  })
}

function mockAccountInfo(): AccountInfo {
  return {
    getDownloadUrl: () => 'https://download.example.com',
    getAuthToken: () => 'auth-token',
  } as AccountInfo
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
    expect(result.headers.contentSha1).toBe(await sha1Hex(content))
    expect(result.headers.uploadTimestamp).toBeGreaterThan(0)
  })

  it('errors with ChecksumMismatchError when body does not match X-Bz-Content-Sha1', async () => {
    const expectedBody = new TextEncoder().encode('expected body')
    const corruptBody = new TextEncoder().encode('corrupt body')
    const expectedSha1 = await sha1Hex(expectedBody)
    const raw = new RawClient({
      transport: {
        async send(): Promise<HttpResponse> {
          return byteResponse(200, corruptBody, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(corruptBody.byteLength),
            'X-Bz-File-Id': 'bad_download_sha1',
            'X-Bz-File-Name': 'bad-sha1.bin',
            'X-Bz-Content-Sha1': expectedSha1,
            'X-Bz-Upload-Timestamp': '1',
          })
        },
      },
    })
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const result = await downloadById(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'bad_download_sha1' as FileId,
    })

    await expect(readStream(result.body)).rejects.toBeInstanceOf(ChecksumMismatchError)
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

  it('fires onProgress per chunk and a completePart event when the body is drained', async () => {
    // Locks the contract: when `onProgress` is supplied, the body stream
    // is wrapped in a TransformStream that counts bytes through and
    // emits a `partsCompleted: 1` event on `flush`. The last reported
    // bytesTransferred must equal the file size, totalParts must be 1
    // (single-request download is treated as a single "part").
    const bucket = await client.createBucket({
      bucketName: 'dl-progress',
      bucketType: 'allPrivate',
    })
    const payload = new TextEncoder().encode('progress-payload')
    await bucket.upload({
      fileName: 'p.bin',
      source: new BufferSource(payload),
    })

    const events: Array<{
      bytesTransferred: number
      totalBytes: number | null
      partsCompleted: number
      totalParts: number | null
    }> = []
    const result = await downloadByName(client.raw, client.accountInfo, {
      bucketName: 'dl-progress',
      fileName: 'p.bin',
      onProgress: (event) => {
        events.push({
          bytesTransferred: event.bytesTransferred,
          totalBytes: event.totalBytes,
          partsCompleted: event.partsCompleted,
          totalParts: event.totalParts,
        })
      },
    })
    // Drain the body so the `flush()` branch of the TransformStream fires.
    await readStream(result.body)

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.bytesTransferred).toBe(payload.byteLength)
    expect(last?.totalBytes).toBe(payload.byteLength)
    expect(last?.partsCompleted).toBe(1)
    expect(last?.totalParts).toBe(1)
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
function byteResponse(status: number, data: Uint8Array, headers?: HeadersInit): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(data)
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

function jsonResponse<T extends Record<string, unknown>>(
  status: number,
  payload: T,
  headers?: HeadersInit,
): HttpResponse {
  const text = JSON.stringify(payload)
  const data = new TextEncoder().encode(text)
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json')
  return {
    ...byteResponse(status, data, responseHeaders),
    json: <U>() => Promise.resolve(payload as unknown as U),
    text: () => Promise.resolve(text),
  }
}

function createMockTransport(
  fileData: Uint8Array,
  fileId: string,
  options?: {
    contentSha1?: string
    onDownload?: (
      request: HttpRequest,
      rangeHeader: string | undefined,
    ) => HttpResponse | undefined | Promise<HttpResponse | undefined>
  },
): HttpTransport {
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
        const override = await options?.onDownload?.(request, rangeHeader)
        if (override !== undefined) return override

        let data = fileData
        let status = 200
        let contentRange: string | undefined

        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/)
          if (match) {
            const start = Number.parseInt(match[1] ?? '0', 10)
            const end =
              match[2] !== undefined ? Number.parseInt(match[2], 10) : fileData.byteLength - 1
            data = fileData.slice(start, end + 1)
            status = 206
            contentRange = `bytes ${start}-${end}/${fileData.byteLength}`
          }
        }

        const responseHeaders = new Headers({
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          ...(contentRange !== undefined ? { 'Content-Range': contentRange } : {}),
          'X-Bz-File-Id': fileId,
          'X-Bz-File-Name': 'mock-file.bin',
          'X-Bz-Content-Sha1': options?.contentSha1 ?? 'none',
          'X-Bz-Upload-Timestamp': String(Date.now()),
        })

        return byteResponse(status, new Uint8Array(data), responseHeaders)
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

    const transport = createMockTransport(fileData, fakeFileId, {
      contentSha1: await sha1Hex(fileData),
    })
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

  it('errors with ChecksumMismatchError when range SHA-1 headers disagree', async () => {
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i
    const expectedSha1 = await sha1Hex(fileData)
    const fakeFileId = 'parallel_changed_sha1'
    const transport = createMockTransport(fileData, fakeFileId, {
      contentSha1: expectedSha1,
      onDownload: (_request, rangeHeader) => {
        if (rangeHeader !== 'bytes=30-59') return undefined
        const data = fileData.slice(30, 60)
        return byteResponse(206, data, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          'Content-Range': `bytes 30-59/${fileData.byteLength}`,
          'X-Bz-File-Id': fakeFileId,
          'X-Bz-File-Name': 'mock-file.bin',
          'X-Bz-Content-Sha1': '0'.repeat(40),
          'X-Bz-Upload-Timestamp': '1',
        })
      },
    })
    const raw = new RawClient({ transport })
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

    await expect(readStream(stream)).rejects.toBeInstanceOf(ChecksumMismatchError)
  })

  it.each([
    ['first range lacks a digest and a later range has one', 'bytes=0-29', 'none'],
    ['later range drops the digest after the first range sets one', 'bytes=30-59', undefined],
  ])('errors with ChecksumMismatchError when %s', async (_caseName, overrideRange, headerValue) => {
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i
    const expectedSha1 = await sha1Hex(fileData)
    const fakeFileId = 'parallel_sha1_presence_changed'
    const transport = createMockTransport(fileData, fakeFileId, {
      contentSha1: expectedSha1,
      onDownload: (_request, rangeHeader) => {
        if (rangeHeader !== overrideRange) return undefined
        const range = rangeHeader === 'bytes=0-29' ? { start: 0, end: 29 } : { start: 30, end: 59 }
        const data = fileData.slice(range.start, range.end + 1)
        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          'Content-Range': `bytes ${range.start}-${range.end}/${fileData.byteLength}`,
          'X-Bz-File-Id': fakeFileId,
          'X-Bz-File-Name': 'mock-file.bin',
          'X-Bz-Upload-Timestamp': '1',
        }
        if (headerValue !== undefined) headers['X-Bz-Content-Sha1'] = headerValue
        return byteResponse(206, data, headers)
      },
    })
    const raw = new RawClient({ transport })
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

    await expect(readStream(stream)).rejects.toBeInstanceOf(ChecksumMismatchError)
  })

  it('errors with ChecksumMismatchError when assembled ranges fail SHA-1 verification', async () => {
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i
    const expectedSha1 = await sha1Hex(fileData)
    const fakeFileId = 'parallel_bad_sha1'
    const transport = createMockTransport(fileData, fakeFileId, {
      contentSha1: expectedSha1,
      onDownload: (_request, rangeHeader) => {
        if (rangeHeader !== 'bytes=30-59') return undefined
        const data = fileData.slice(30, 60)
        data[0] = 255
        return byteResponse(206, data, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
          'Content-Range': `bytes 30-59/${fileData.byteLength}`,
          'X-Bz-File-Id': fakeFileId,
          'X-Bz-File-Name': 'mock-file.bin',
          'X-Bz-Content-Sha1': expectedSha1,
          'X-Bz-Upload-Timestamp': '1',
        })
      },
    })
    const raw = new RawClient({ transport })
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

    await expect(readStream(stream)).rejects.toBeInstanceOf(ChecksumMismatchError)
  })

  it('single-range download works when file is smaller than range size', async () => {
    const fileData = new Uint8Array(15)
    for (let i = 0; i < 15; i++) fileData[i] = i + 10
    const fakeFileId = 'fake_file_002'

    const transport = createMockTransport(fileData, fakeFileId)
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

  it('closes cleanly for a zero-byte parallel download', async () => {
    const fakeFileId = 'empty-parallel'
    const raw = new RawClient({
      transport: {
        async send(): Promise<HttpResponse> {
          throw new Error('Zero-byte parallel downloads should not request ranges')
        },
      },
    })
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 0,
      rangeSize: 30,
      concurrency: 2,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(0)
  })

  it('handles the last range being shorter than rangeSize', async () => {
    // 50 bytes with 20-byte ranges: chunks are [0-19], [20-39], [40-49]
    const fileData = new Uint8Array(50)
    for (let i = 0; i < 50; i++) fileData[i] = 200 - i
    const fakeFileId = 'fake_file_003'

    const transport = createMockTransport(fileData, fakeFileId)
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

  // Branch: single-range case (totalSize <= rangeSize). The chunking loop
  // produces exactly one range and the post-Promise.all flush emits it.
  it('handles a single-range download (totalSize <= rangeSize)', async () => {
    const fileData = new Uint8Array(50)
    for (let i = 0; i < 50; i++) fileData[i] = i
    const fakeFileId = 'fake-single-range'
    const transport = createMockTransport(fileData, fakeFileId)

    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 50,
      rangeSize: 100, // larger than file -> single range
      concurrency: 4,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(50)
    for (let i = 0; i < 50; i++) expect(result[i]).toBe(i)
  })

  // Branch: response with body === null triggers the explicit "no body" throw
  // inside fetchRangeWithRetry. Without retries, the error propagates and
  // the controller errors the stream.
  it('errors the stream when a range response has no body', async () => {
    const fakeFileId = 'no-body'
    const transport: HttpTransport = {
      async send(request: HttpRequest): Promise<HttpResponse> {
        if (request.url.includes('b2_authorize_account')) {
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
          return {
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(JSON.stringify(body)))
                c.close()
              },
            }),
            json: <T>() => Promise.resolve(body as T),
            text: () => Promise.resolve(JSON.stringify(body)),
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          }
        }
        // The interesting branch: body === null on an otherwise valid range response.
        return {
          status: 206,
          headers: new Headers({ 'Content-Length': '0', 'Content-Range': 'bytes 0-29/100' }),
          body: null,
          json: () => Promise.reject(new Error('no body')),
          text: () => Promise.resolve(''),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }
      },
    }

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 100,
      rangeSize: 30,
      concurrency: 2,
      maxRetries: 0,
    })

    await expect(readStream(stream)).rejects.toThrow(/no body/i)
  })

  it('does not retry non-retryable B2 errors for a range', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'non-retryable'
    let attempts = 0
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () => {
        attempts++
        return jsonResponse(403, {
          status: 403,
          code: 'access_denied',
          message: 'denied',
        })
      },
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
      maxRetries: 2,
    })

    await expect(readStream(stream)).rejects.toThrow(/denied/i)
    expect(attempts).toBe(1)
  })

  it('uses only the transport retry budget by default', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'transport-budget'
    let attempts = 0
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () => {
        attempts++
        return jsonResponse(503, {
          status: 503,
          code: 'service_unavailable',
          message: 'try again',
        })
      },
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
      retry: {
        maxRetries: 1,
        initialRetryDelayMs: 1,
        maxRetryDelayMs: 1,
      },
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
    })

    await expect(readStream(stream)).rejects.toThrow(/try again/i)
    expect(attempts).toBe(2)
  })

  it('rejects a ranged response that returns 200 instead of 206', async () => {
    const fileData = new Uint8Array(30)
    for (let i = 0; i < 30; i++) fileData[i] = i
    const fakeFileId = 'wrong-status'
    let attempts = 0
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () => {
        attempts++
        return byteResponse(200, fileData, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileData.byteLength),
        })
      },
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
      maxRetries: 2,
    })

    await expect(readStream(stream)).rejects.toThrow(/Expected HTTP 206/i)
    expect(attempts).toBe(1)
  })

  it('rejects a ranged response with mismatched Content-Range', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'wrong-content-range'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () =>
        byteResponse(206, fileData, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileData.byteLength),
          'Content-Range': 'bytes 1-30/31',
        }),
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
    })

    await expect(readStream(stream)).rejects.toThrow(/does not match requested range/i)
  })

  it.each([
    ['missing Content-Range', {}, /Missing Content-Range/i],
    ['invalid Content-Range', { 'Content-Range': 'bytes nope' }, /Invalid Content-Range/i],
    ['wildcard total size', { 'Content-Range': 'bytes 0-29/*' }, /does not include total size/i],
    [
      'wrong total size',
      { 'Content-Range': 'bytes 0-29/31' },
      /does not match expected total size/i,
    ],
  ])('rejects a ranged response with %s', async (_caseName, extraHeaders, expected) => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'bad-content-range'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () =>
        byteResponse(206, fileData, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(fileData.byteLength),
          ...extraHeaders,
        }),
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
    })

    await expect(readStream(stream)).rejects.toThrow(expected)
  })

  it('rejects truncated range bodies', async () => {
    const fileData = new Uint8Array(30)
    const truncated = fileData.slice(0, 29)
    const fakeFileId = 'truncated'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () =>
        byteResponse(206, truncated, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(truncated.byteLength),
          'Content-Range': 'bytes 0-29/30',
        }),
    })

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
    })

    await expect(readStream(stream)).rejects.toThrow(/Expected 30 bytes/i)
  })

  it('classifies raw non-2xx range responses before retry decisions', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'raw-503'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () =>
        jsonResponse(
          503,
          {
            status: 503,
            code: 'service_unavailable',
            message: 'try again',
          },
          {
            'Retry-After': '7',
            'X-Bz-Request-Id': 'req-123',
          },
        ),
    })
    const raw = new RawClient({ transport })
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
      maxRetries: 0,
    })

    await expect(readStream(stream)).rejects.toMatchObject({
      name: 'ServiceUnavailableError',
      status: 503,
      code: 'service_unavailable',
      retryable: true,
      retryAfter: 7,
      requestId: 'req-123',
    })
  })

  it('classifies synthetic 500 range errors as internal errors', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'raw-500'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () =>
        byteResponse(500, new TextEncoder().encode('not json'), {
          'Content-Type': 'text/plain',
        }),
    })
    const raw = new RawClient({ transport })
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
      maxRetries: 0,
    })

    await expect(readStream(stream)).rejects.toMatchObject({
      name: 'InternalError',
      status: 500,
      code: 'internal_error',
      message: 'HTTP 500',
      retryable: true,
    })
  })

  it('classifies raw non-2xx range responses without bodies', async () => {
    const fileData = new Uint8Array(30)
    const fakeFileId = 'raw-429'
    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: () => ({
        status: 429,
        headers: new Headers(),
        body: null,
        json: () => Promise.reject(new Error('No JSON body')),
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    })
    const raw = new RawClient({ transport })
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 30,
      rangeSize: 30,
      concurrency: 1,
      maxRetries: 0,
    })

    await expect(readStream(stream)).rejects.toMatchObject({
      name: 'TooManyRequestsError',
      status: 429,
      code: 'internal_error',
      retryable: true,
    })
  })

  // Branch: AbortSignal already aborted when the stream starts. The first
  // task's `abort?.throwIfAborted()` should fire before any fetch happens.
  it('errors the stream when the abort signal is already aborted at start', async () => {
    const fileData = new Uint8Array(100)
    const fakeFileId = 'pre-aborted'
    const transport = createMockTransport(fileData, fakeFileId)

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    const controller = new AbortController()
    controller.abort()

    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 100,
      rangeSize: 30,
      concurrency: 2,
      signal: controller.signal,
    })

    await expect(readStream(stream)).rejects.toBeDefined()
  })

  // Branch: rangeSize and concurrency at their defaults (options omitted).
  // Exercises the `?? 10 * 1024 * 1024` and `?? 4` fallbacks at the top of
  // createParallelDownloadStream.
  it('falls back to default rangeSize and concurrency when omitted', async () => {
    const fileData = new Uint8Array(64)
    for (let i = 0; i < 64; i++) fileData[i] = i + 1
    const fakeFileId = 'defaults'
    const transport = createMockTransport(fileData, fakeFileId)

    const client = new B2Client({
      applicationKeyId: 'k',
      applicationKey: 'k',
      transport,
    })
    await client.authorize()

    // 64 bytes is well under the 10 MB default rangeSize, so we get one range.
    const stream = createParallelDownloadStream(client.raw, client.accountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 64,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(64)
    expect(result[0]).toBe(1)
    expect(result[63]).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// parallel.ts with simulator (end-to-end)
// ---------------------------------------------------------------------------

// `createParallelDownloadStream per-range retry` describe block was moved to
// `download.slow.test.ts`. The retry tests pay wall-clock from exponential
// backoff between attempts and were the slowest items in this file.

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

  it('headById cancels a non-null HEAD response body internally', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const raw = {
      downloadFileById: vi.fn().mockResolvedValue({
        headers: headResponseHeaders('by-id.txt'),
        body: { cancel },
      }),
    } as unknown as RawClient

    const result = await headById(raw, mockAccountInfo(), {
      fileId: 'head_id' as unknown as FileId,
    })

    expect(result.headers.fileName).toBe('by-id.txt')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(raw.downloadFileById).toHaveBeenCalledWith(
      'https://download.example.com',
      'auth-token',
      'head_id',
      { method: 'HEAD' },
    )
  })

  it('headByName cancels a non-null HEAD response body internally', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const raw = {
      downloadFileByName: vi.fn().mockResolvedValue({
        headers: headResponseHeaders('by-name.txt'),
        body: { cancel },
      }),
    } as unknown as RawClient

    const result = await headByName(raw, mockAccountInfo(), {
      bucketName: 'bucket',
      fileName: 'by-name.txt',
    })

    expect(result.headers.fileName).toBe('by-name.txt')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(raw.downloadFileByName).toHaveBeenCalledWith(
      'https://download.example.com',
      'auth-token',
      'bucket',
      'by-name.txt',
      { method: 'HEAD' },
    )
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

  it('Bucket.head() returns headers-only — no body field to clean up', async () => {
    // The action repo asked us to encode HEAD-vs-GET in types so consumers
    // never have to remember to `body.cancel()` after a metadata fetch.
    // Verify the new `head()` method:
    //   1. returns just `{ headers }` (no body in the result shape)
    //   2. populates the same headers as `download({ method: 'HEAD' })`
    //   3. doesn't expose the body lifecycle to the caller
    const bucket = await client.createBucket({
      bucketName: 'bucket-head-typed',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('typed HEAD payload')
    await bucket.upload({
      fileName: 'metadata-only.bin',
      source: new BufferSource(content),
    })

    const result = await bucket.head('metadata-only.bin')
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileName).toBe('metadata-only.bin')
    // Crucial: the result has NO `body` field. The action's v8-ignored
    // try/catch around `result.body.cancel()` is now unreachable code
    // (TypeScript would reject `result.body` at compile time).
    expect('body' in (result as object)).toBe(false)
  })

  it('B2Object.head() returns headers-only', async () => {
    const bucket = await client.createBucket({
      bucketName: 'object-head-typed',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('object HEAD payload')
    await bucket.upload({
      fileName: 'obj-meta.bin',
      source: new BufferSource(content),
    })

    const result = await bucket.file('obj-meta.bin').head()
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect('body' in (result as object)).toBe(false)
  })

  it('B2Object.headById() returns headers-only for a specific version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'object-headById-typed',
      bucketType: 'allPrivate',
    })
    const content = new TextEncoder().encode('versioned HEAD payload')
    const uploaded = await bucket.upload({
      fileName: 'obj-versioned-meta.bin',
      source: new BufferSource(content),
    })

    const result = await bucket.file('obj-versioned-meta.bin').headById(uploaded.fileId)
    expect(result.headers.contentLength).toBe(content.byteLength)
    expect(result.headers.fileId).toBe(uploaded.fileId)
    expect('body' in (result as object)).toBe(false)
  })
})
