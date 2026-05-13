import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { readStream } from '../test-utils/index.ts'
import type { FileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

/**
 * Slow tier for `createParallelDownloadStream`: the per-range retry tests
 * exercise the retry/backoff path which adds wall-clock from exponential
 * sleep timers between attempts. Lives in a `*.slow.test.ts` file so
 * `pnpm test` (fast feedback) skips it; `pnpm test:slow` and
 * `pnpm test:coverage` pick it up.
 */

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
