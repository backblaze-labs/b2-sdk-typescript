import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { B2Client } from '../client.ts'
import { ChecksumMismatchError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { RawClient } from '../raw/index.ts'
import { sha1Hex } from '../streams/hash.ts'
import { readStream } from '../test-utils/index.ts'
import { EncryptionAlgorithm } from '../types/encryption.ts'
import type { FileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'
import { headById, headByName } from './single.ts'

// ---------------------------------------------------------------------------
// single.ts - downloadByName
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// single.ts - downloadById
// ---------------------------------------------------------------------------

describe('head downloads', () => {
  const accountInfo = {
    getDownloadUrl: () => 'http://mock:0',
    getAuthToken: () => 'mock_token',
  } as unknown as AccountInfo

  function headResponse(fileName: string, onCancel: () => void): HttpResponse {
    return {
      status: 200,
      headers: new Headers({
        'Content-Length': '0',
        'X-Bz-File-Id': 'head_file_id',
        'X-Bz-File-Name': fileName,
        'X-Bz-Content-Sha1': 'none',
        'X-Bz-Upload-Timestamp': '1',
      }),
      body: new ReadableStream<Uint8Array>({
        cancel() {
          onCancel()
        },
      }),
      json: () => Promise.reject(new Error('Not JSON')),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    }
  }

  it('cancels synthetic HEAD bodies by ID and by name', async () => {
    let idBodyCancelled = false
    let nameBodyCancelled = false
    const raw = {
      async downloadFileById(
        _downloadUrl: string,
        _authToken: string,
        _fileId: FileId,
        options: { readonly method?: string },
      ): Promise<HttpResponse> {
        expect(options.method).toBe('HEAD')
        return headResponse('by-id.txt', () => {
          idBodyCancelled = true
        })
      },
      async downloadFileByName(
        _downloadUrl: string,
        _authToken: string,
        _bucketName: string,
        _fileName: string,
        options: { readonly method?: string },
      ): Promise<HttpResponse> {
        expect(options.method).toBe('HEAD')
        return headResponse('by-name.txt', () => {
          nameBodyCancelled = true
        })
      },
    } as unknown as RawClient

    const byId = await headById(raw, accountInfo, { fileId: 'head_id' as FileId })
    const byName = await headByName(raw, accountInfo, {
      bucketName: 'bucket',
      fileName: 'by-name.txt',
    })

    expect(byId.headers.fileName).toBe('by-id.txt')
    expect(byName.headers.fileName).toBe('by-name.txt')
    expect(idBodyCancelled).toBe(true)
    expect(nameBodyCancelled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// single.ts - extractDownloadHeaders (tested indirectly)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parallel.ts - createParallelDownloadStream
// ---------------------------------------------------------------------------

/**
 * Mock transport that serves ranged download requests for a known file.
 * Used to test createParallelDownloadStream in isolation.
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

  it('passes SSE-C headers to every ranged request', async () => {
    const fileData = new Uint8Array(100)
    for (let i = 0; i < 100; i++) fileData[i] = i
    const fakeFileId = 'parallel_sse_c_headers'
    const seenHeaders: Record<string, string>[] = []
    const serverSideEncryption = {
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey: 'customer-key',
      customerKeyMd5: 'customer-key-md5',
    }

    const transport = createMockTransport(fileData, fakeFileId, {
      onDownload: (request) => {
        seenHeaders.push(request.headers ?? {})
        return undefined
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
      rangeSize: 25,
      concurrency: 2,
      serverSideEncryption,
    })

    const result = await readStream(stream)
    expect(result.byteLength).toBe(100)
    expect(seenHeaders).toHaveLength(4)
    for (const headers of seenHeaders) {
      expect(headers['X-Bz-Server-Side-Encryption-Customer-Algorithm']).toBe(
        EncryptionAlgorithm.Aes256,
      )
      expect(headers['X-Bz-Server-Side-Encryption-Customer-Key']).toBe(
        serverSideEncryption.customerKey,
      )
      expect(headers['X-Bz-Server-Side-Encryption-Customer-Key-Md5']).toBe(
        serverSideEncryption.customerKeyMd5,
      )
    }
  })

  it('aborts in-flight ranged requests when canceled', async () => {
    const seenSignals: AbortSignal[] = []
    const raw = {
      async downloadFileById(
        _downloadUrl: string,
        _authToken: string,
        _fileId: string,
        options?: unknown,
      ): Promise<{
        headers: Headers
        body: ReadableStream<Uint8Array> | null
        status: number
      }> {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal === undefined) throw new Error('missing abort signal')
        seenSignals.push(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'parallel_cancel_inflight' as FileId,
      totalSize: 100,
      rangeSize: 25,
      concurrency: 2,
    })

    expect(seenSignals).toHaveLength(4)
    await expect(stream.cancel('caller stopped reading')).resolves.toBeUndefined()
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true)
  })

  it('aborts in-flight ranged requests when the caller signal aborts', async () => {
    const controller = new AbortController()
    const seenSignals: AbortSignal[] = []
    const abortError = new Error('caller aborted')
    const raw = {
      async downloadFileById(
        _downloadUrl: string,
        _authToken: string,
        _fileId: string,
        options?: unknown,
      ): Promise<{
        headers: Headers
        body: ReadableStream<Uint8Array> | null
        status: number
      }> {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal === undefined) throw new Error('missing abort signal')
        seenSignals.push(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'parallel_caller_abort_inflight' as FileId,
      totalSize: 100,
      rangeSize: 25,
      concurrency: 2,
      signal: controller.signal,
    })

    expect(seenSignals).toHaveLength(4)
    controller.abort(abortError)

    await expect(readStream(stream)).rejects.toThrow(/caller aborted/)
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true)
  })

  it('aborts sibling ranged requests when one range fails', async () => {
    const seenSignals: AbortSignal[] = []
    let calls = 0
    const raw = {
      async downloadFileById(
        _downloadUrl: string,
        _authToken: string,
        _fileId: string,
        options?: unknown,
      ): Promise<{
        headers: Headers
        body: ReadableStream<Uint8Array> | null
        status: number
      }> {
        calls++
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal
        if (signal === undefined) throw new Error('missing abort signal')
        seenSignals.push(signal)
        if (calls === 1) {
          return jsonResponse(403, {
            status: 403,
            code: 'access_denied',
            message: 'denied',
          })
        }
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: 'parallel_abort_siblings' as FileId,
      totalSize: 100,
      rangeSize: 25,
      concurrency: 2,
      maxRetries: 0,
    })

    await expect(readStream(stream)).rejects.toThrow(/denied/)
    expect(seenSignals).toHaveLength(4)
    expect(seenSignals.slice(1).every((signal) => signal.aborted)).toBe(true)
  })

  it('does not leak SSE-C keys in parallel download failure diagnostics', async () => {
    const fakeFileId = 'parallel_sse_c_error'
    const seenOptions: unknown[] = []
    const serverSideEncryption = {
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey: 'cGFyYWxsZWwtZG93bmxvYWQtc2VjcmV0LWtleQ==',
      customerKeyMd5: 'cGFyYWxsZWwtZG93bmxvYWQtc2VjcmV0LW1kNQ==',
    }
    const raw = {
      async downloadFileById(
        _downloadUrl: string,
        _authToken: string,
        _fileId: string,
        options?: unknown,
      ): Promise<{
        headers: Headers
        body: ReadableStream<Uint8Array> | null
        status: number
      }> {
        seenOptions.push(options)
        return jsonResponse(503, {
          status: 503,
          code: 'service_unavailable',
          message: 'temporary failure',
        })
      },
    } as unknown as RawClient
    const accountInfo = {
      getDownloadUrl: () => 'http://mock:0',
      getAuthToken: () => 'mock_token',
    }

    const stream = createParallelDownloadStream(raw, accountInfo as unknown as AccountInfo, {
      fileId: fakeFileId as FileId,
      totalSize: 25,
      rangeSize: 25,
      concurrency: 1,
      serverSideEncryption,
      maxRetries: 0,
    })

    let thrown: unknown
    try {
      await readStream(stream)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(seenOptions).toHaveLength(1)
    const diagnostics = [
      String(thrown),
      thrown instanceof Error ? thrown.message : '',
      JSON.stringify(thrown),
      ...seenOptions.map((options) => JSON.stringify(options)),
    ].join('\n')
    expect(diagnostics).not.toContain(serverSideEncryption.customerKey)
    expect(diagnostics).not.toContain(serverSideEncryption.customerKeyMd5)
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

// `createParallelDownloadStream per-range retry` describe block was moved to
// `download.slow.test.ts`. The retry tests pay wall-clock from exponential
// backoff between attempts and were the slowest items in this file.

// ---------------------------------------------------------------------------
// Tier 1: HEAD method + response-header overrides on downloadById
// ---------------------------------------------------------------------------
