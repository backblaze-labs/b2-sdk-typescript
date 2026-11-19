import { describe, expect, it, vi } from 'vitest'
import { NetworkError } from '../errors/index.ts'
import { RawClient } from '../raw/index.ts'
import { jsonErrorResponse, jsonResponse } from '../test-utils/index.ts'
import { accountId, bucketId, fileId } from '../types/ids.ts'
import type { HttpRequest, HttpTransport } from './transport.ts'
import { RetryTransport } from './transport.ts'

const apiUrl = 'https://api.example.test'
const authToken = 'test-auth-token'
const mutations = [
  {
    endpoint: 'b2_create_key',
    invoke: (raw: RawClient) =>
      raw.createKey(apiUrl, authToken, {
        accountId: accountId('account'),
        keyName: 'example-key',
        capabilities: ['readFiles'],
      }),
  },
  {
    endpoint: 'b2_create_bucket',
    invoke: (raw: RawClient) =>
      raw.createBucket(apiUrl, authToken, {
        accountId: accountId('account'),
        bucketName: 'example-bucket',
        bucketType: 'allPrivate',
      }),
  },
  {
    endpoint: 'b2_copy_file',
    invoke: (raw: RawClient) =>
      raw.copyFile(apiUrl, authToken, {
        sourceFileId: fileId('source'),
        fileName: 'copy.txt',
      }),
  },
  {
    endpoint: 'b2_hide_file',
    invoke: (raw: RawClient) =>
      raw.hideFile(apiUrl, authToken, {
        bucketId: bucketId('bucket'),
        fileName: 'example.txt',
      }),
  },
] as const

function retryTransport(send: HttpTransport['send']): RetryTransport {
  return new RetryTransport({
    transport: { send },
    retry: { maxRetries: 2, initialRetryDelayMs: 0, maxRetryDelayMs: 0 },
    sleepImpl: async () => {},
  })
}

describe('native mutation retry policy', () => {
  describe.each(mutations)('$endpoint', ({ endpoint, invoke }) => {
    it.each([500, 502, 503, 504])('does not replay after HTTP %i', async (status) => {
      const send = vi.fn<HttpTransport['send']>(async () =>
        jsonErrorResponse(status, 'internal_error', 'Temporary service failure'),
      )
      const raw = new RawClient({ transport: retryTransport(send) })

      await expect(invoke(raw)).rejects.toMatchObject({
        status,
        code: 'internal_error',
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        method: 'POST',
        url: `${apiUrl}/b2api/v4/${endpoint}`,
      })
    })

    it('does not replay after a connection failure', async () => {
      // Fetch rejects with TypeError when a connection fails, including when
      // the server may already have applied the request.
      const failure = new TypeError('Connection closed before response')
      const send = vi.fn<HttpTransport['send']>(async () => {
        throw failure
      })
      const raw = new RawClient({ transport: retryTransport(send) })

      await expect(invoke(raw)).rejects.toBeInstanceOf(NetworkError)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('marks the raw request as non-idempotent for custom transports', async () => {
      const send = vi.fn<HttpTransport['send']>(async () => {
        throw new TypeError('Connection closed before response')
      })

      await expect(invoke(new RawClient({ transport: { send } }))).rejects.toThrow(
        'Connection closed before response',
      )
      expect(send.mock.calls[0]?.[0].idempotent).toBe(false)
    })

    it.each(['HTTP 503', 'connection failure'])(
      'does not replay an unmarked transport request after %s',
      async (fault) => {
        const send = vi.fn<HttpTransport['send']>(async () => {
          if (fault === 'connection failure')
            throw new TypeError('Connection closed before response')
          return jsonErrorResponse(503, 'service_unavailable', 'Try again')
        })

        await expect(
          retryTransport(send).send({
            method: 'POST',
            url: `${apiUrl}/b2api/v4/${endpoint}`,
            body: '{}',
          }),
        ).rejects.toThrow()
        expect(send).toHaveBeenCalledTimes(1)
      },
    )
  })

  it.each(['HTTP 503', 'connection failure'])(
    'still retries a safe GET after %s',
    async (fault) => {
      const send = vi.fn<HttpTransport['send']>()
      if (fault === 'HTTP 503') {
        send.mockResolvedValueOnce(jsonErrorResponse(503, 'service_unavailable', 'Try again'))
      } else {
        send.mockRejectedValueOnce(new TypeError('Connection closed before response'))
      }
      send.mockResolvedValueOnce(jsonResponse({ content: 'downloaded' }))
      const request: HttpRequest = {
        url: `${apiUrl}/file/example-bucket/example.txt`,
        method: 'GET',
      }

      const response = await retryTransport(send).send(request)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ content: 'downloaded' })
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls.map(([sent]) => [sent.method, sent.url])).toEqual([
        ['GET', request.url],
        ['GET', request.url],
      ])
    },
  )

  it.each(['HTTP 503', 'connection failure'])(
    'still retries a read-only native POST after %s',
    async (fault) => {
      const send = vi.fn<HttpTransport['send']>()
      if (fault === 'HTTP 503') {
        send.mockResolvedValueOnce(jsonErrorResponse(503, 'service_unavailable', 'Try again'))
      } else {
        send.mockRejectedValueOnce(new TypeError('Connection closed before response'))
      }
      send.mockResolvedValueOnce(jsonResponse({ buckets: [] }))
      const raw = new RawClient({ transport: retryTransport(send) })

      await expect(
        raw.listBuckets(apiUrl, authToken, { accountId: accountId('account') }),
      ).resolves.toEqual({ buckets: [] })
      expect(send).toHaveBeenCalledTimes(2)
    },
  )
})
