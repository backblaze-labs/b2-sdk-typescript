import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, it, vi } from 'vitest'

// cspell:ignore unstub

const state = vi.hoisted(() => ({
  handler: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined,
}))

vi.mock('node:http', () => ({
  createServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    state.handler = handler
    return { listen: () => {} }
  },
}))

vi.mock('@backblaze-labs/b2-sdk', () => ({
  B2Client: class {
    async authorize() {}
    async getBucket() {
      return { name: 'test-bucket' }
    }
  },
}))

vi.mock('@backblaze-labs/b2-sdk/errors', () => ({
  B2Error: class extends Error {},
}))

it('responds to malformed percent encoding with 400 and keeps handling requests', async () => {
  vi.stubEnv('B2_APPLICATION_KEY_ID', 'test-key-id')
  vi.stubEnv('B2_APPLICATION_KEY', 'test-key')
  vi.stubEnv('B2_BUCKET', 'test-bucket')
  try {
    await import('./server.ts')
    expect(state.handler).toBeDefined()
    const handler =
      state.handler ??
      (() => {
        throw new Error('Server did not register a request handler')
      })

    function request(url: string): { status: number | undefined; body: string | undefined } {
      const response: { status: number | undefined; body: string | undefined } = {
        status: undefined,
        body: undefined,
      }
      const req = { method: 'GET', url, headers: {} } as unknown as IncomingMessage
      const res = {
        writeHead(status: number) {
          response.status = status
        },
        end(body: string) {
          response.body = body
        },
      } as unknown as ServerResponse
      handler(req, res)
      return response
    }

    expect(request('/files/%').status).toBe(400)
    expect(request('/healthz')).toEqual({ status: 200, body: 'ok' })
    expect(request('/files/photos/cat.jpg').status).toBe(401)
  } finally {
    vi.unstubAllEnvs()
  }
})
