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
  it('normalizes the deprecated createKey bucketId alias to bucketIds', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        return jsonResponse({
          keyName: 'alias-key',
          applicationKeyId: 'key-id',
          applicationKey: 'secret',
          capabilities: [],
          accountId: 'account',
          expirationTimestamp: null,
          bucketIds: ['bucket'],
          namePrefix: null,
          options: [],
        })
      },
    }
    const raw = new RawClient({ transport })

    const key = await raw.createKey('https://api.example.test', 'auth', {
      accountId: 'account' as never,
      capabilities: [],
      keyName: 'alias-key',
      bucketId: 'bucket' as never,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.example.test/b2api/v4/b2_create_key')
    const body = JSON.parse(requests[0]?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({ bucketIds: ['bucket'] })
    expect('bucketId' in body).toBe(false)
    expect(key.bucketIds).toEqual(['bucket'])
    expect(key.bucketId).toBe('bucket')
  })

  it('rejects conflicting createKey bucketId and bucketIds inputs before transport', async () => {
    const requests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        requests.push(request)
        return jsonResponse({})
      },
    }
    const raw = new RawClient({ transport })

    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'conflict',
        bucketIds: null,
        bucketId: 'bucket' as never,
      }),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'mismatch',
        bucketIds: ['bucket-a' as never],
        bucketId: 'bucket-b' as never,
      }),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    const untrusted = { bucketIds: ['user-bucket' as never] }
    await expect(
      raw.createKey('https://api.example.test', 'auth', {
        accountId: 'account' as never,
        capabilities: [],
        keyName: 'safe-merge',
        ...untrusted,
        bucketId: 'trusted-bucket' as never,
      }),
    ).rejects.toThrow('either bucketIds or deprecated bucketId')

    expect(requests).toEqual([])
  })

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
