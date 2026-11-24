import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse, HttpTransport } from './transport.ts'
import { RetryTransport } from './transport.ts'

function response(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: new Headers(),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

describe('download names resembling upload endpoints', () => {
  it.each(['b2_upload_file', 'b2_upload_part'] as const)(
    'retries a GET named b2api/x/%s after HTTP 500',
    async (name) => {
      const requests: { method: string; url: string }[] = []
      const inner: HttpTransport = {
        async send(req: HttpRequest): Promise<HttpResponse> {
          requests.push({ method: req.method, url: req.url })
          return requests.length === 1
            ? response(500, { status: 500, code: 'internal_error', message: 'boom' })
            : response(200, { ok: true })
        },
      }
      const retrying = new RetryTransport({
        transport: inner,
        retry: { maxRetries: 1, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: async () => {},
      })
      const url = `https://f000.backblazeb2.com/file/my-bucket/b2api/x/${name}`
      const result = await retrying.send({ method: 'GET', url, headers: { Authorization: 'tok' } })
      expect(result.status).toBe(200)
      expect(requests).toEqual([
        { method: 'GET', url },
        { method: 'GET', url },
      ])
    },
  )

  it('reauthorizes a GET named like an upload endpoint after token expiry', async () => {
    const tokens: string[] = []
    let reauthCount = 0
    const inner: HttpTransport = {
      async send(req) {
        tokens.push(req.headers?.['Authorization'] ?? '')
        return tokens.length === 1
          ? response(401, { status: 401, code: 'expired_auth_token', message: 'expired' })
          : response(200, { ok: true })
      },
    }
    const retrying = new RetryTransport({
      transport: inner,
      retry: { maxRetries: 1, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      sleepImpl: async () => {},
      onReauth: async () => {
        reauthCount++
        return 'fresh-token'
      },
    })
    const result = await retrying.send({
      method: 'GET',
      url: 'https://f000.backblazeb2.com/file/my-bucket/b2api/x/b2_upload_file',
      headers: { Authorization: 'old-token' },
    })
    expect(result.status).toBe(200)
    expect(reauthCount).toBe(1)
    expect(tokens).toEqual(['old-token', 'fresh-token'])
  })
})
