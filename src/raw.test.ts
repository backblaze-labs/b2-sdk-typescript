import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse, HttpTransport } from './http/transport.ts'
import { RawClient } from './raw/index.ts'

function jsonResponse(value: unknown): HttpResponse {
  return {
    status: 200,
    headers: new Headers(),
    body: null,
    json: <T>() => Promise.resolve(value as T),
    text: () => Promise.resolve(JSON.stringify(value)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }
}

describe('RawClient list request controls', () => {
  it('passes abort signals and retry through listUnfinishedLargeFiles and listParts', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        if (request.url.endsWith('/b2_list_parts')) {
          return jsonResponse({ parts: [], nextPartNumber: null })
        }
        return jsonResponse({ files: [], nextFileId: null })
      },
    }
    const raw = new RawClient({ transport })
    const controller = new AbortController()
    const retry = { maxRetries: 0 }

    await raw.listUnfinishedLargeFiles(
      'https://api.example.test',
      'auth',
      { bucketId: 'bucket' as never },
      { signal: controller.signal, retry },
    )
    await raw.listParts(
      'https://api.example.test',
      'auth',
      { fileId: 'large-file' as never },
      { signal: controller.signal, retry },
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.signal).toBe(controller.signal)
    expect(requests[0]?.retry).toBe(retry)
    expect(requests[1]?.signal).toBe(controller.signal)
    expect(requests[1]?.retry).toBe(retry)
  })
})
