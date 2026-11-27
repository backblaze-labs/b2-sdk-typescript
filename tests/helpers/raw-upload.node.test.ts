import { describe, expect, it } from 'vitest'
import { B2Client } from '../../src/client.ts'
import { UploadResponseBodyError } from '../../src/errors/index.ts'
import type { HttpRequest, HttpTransport } from '../../src/http/transport.ts'
import { sha1Hex } from '../../src/streams/hash.ts'
import { jsonErrorResponse, jsonResponse } from '../../src/test-utils/index.ts'
import { resetRemoteSimulator } from '../../src/test-utils/remote-simulator.ts'
import { uploadRawFile } from './raw-upload.ts'

const retry = { maxRetries: 2, initialRetryDelayMs: 0, maxRetryDelayMs: 0 }

async function fixture(failures: number, status = 500, malformedSuccess = false) {
  const sim = await resetRemoteSimulator()
  const inner = sim.transport()
  const requests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request) {
      const endpoint = new URL(request.url).pathname.split('/').at(-1)
      if (endpoint === 'b2_get_upload_url' || endpoint === 'b2_upload_file') {
        requests.push(request)
      }
      if (endpoint === 'b2_upload_file' && failures-- > 0) {
        if (malformedSuccess) {
          const response = jsonResponse({})
          return {
            ...response,
            json: async () => {
              throw new SyntaxError('invalid success body')
            },
          }
        }
        return jsonErrorResponse(
          status,
          status === 500 ? 'internal_error' : 'bad_request',
          'fixture',
        )
      }
      return inner.send(request)
    },
  }
  const client = new B2Client({
    applicationKeyId: 'test-key',
    applicationKey: 'test-secret',
    realm: sim.realm,
    transport,
    retry: { maxRetries: 0 },
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'raw-recovery-test',
    bucketType: 'allPrivate',
  })
  const data = new TextEncoder().encode('retry the same bytes')
  const headers = {
    fileName: 'test.txt',
    contentType: 'text/plain',
    contentLength: data.byteLength,
    contentSha1: await sha1Hex(data),
    contentDisposition: 'attachment; filename="test.txt"',
  }
  return { client, bucket, data, headers, requests }
}

describe('live raw upload recovery', () => {
  it('fetches fresh URLs and tokens after 500 while preserving the raw payload and metadata', async () => {
    const f = await fixture(2)
    const events: number[] = []
    const uploaded = await uploadRawFile(f.client, f.bucket.id, f.headers, f.data, {
      retry,
      onUploadRetry: (event) => events.push(event.attempt),
    })
    expect(uploaded.fileName).toBe(f.headers.fileName)
    expect(uploaded.contentSha1).toBe(f.headers.contentSha1)
    expect(uploaded.fileInfo).toMatchObject({
      'b2-content-disposition': f.headers.contentDisposition,
    })
    expect(f.requests.map((r) => new URL(r.url).pathname.split('/').at(-1))).toEqual([
      'b2_get_upload_url',
      'b2_upload_file',
      'b2_get_upload_url',
      'b2_upload_file',
      'b2_get_upload_url',
      'b2_upload_file',
    ])
    const uploads = f.requests.filter((r) => r.url.includes('b2_upload_file'))
    expect(new Set(uploads.map((r) => r.url)).size).toBe(3)
    expect(new Set(uploads.map((r) => r.headers?.Authorization)).size).toBe(3)
    for (const request of uploads) {
      expect(request.body).toEqual(f.data)
      expect(request.headers?.['X-Bz-Info-b2-content-disposition']).toBe(
        'attachment%3B%20filename%3D%22test.txt%22',
      )
      expect(request.retry?.maxRetries).toBe(0)
    }
    expect(events).toEqual([1, 2])
  })

  it('propagates persistent service failures when the bounded budget is exhausted', async () => {
    const f = await fixture(10)
    await expect(
      uploadRawFile(f.client, f.bucket.id, f.headers, f.data, { retry, onUploadRetry: () => {} }),
    ).rejects.toMatchObject({ status: 500 })
    expect(f.requests.filter((r) => r.url.includes('b2_upload_file'))).toHaveLength(3)
  })

  it('does not retry deterministic bad requests', async () => {
    const f = await fixture(10, 400)
    await expect(
      uploadRawFile(f.client, f.bucket.id, f.headers, f.data, { retry }),
    ).rejects.toMatchObject({ status: 400 })
    expect(f.requests).toHaveLength(2)
  })

  it('does not replay an upload after an unreadable success response', async () => {
    const f = await fixture(1, 500, true)
    await expect(
      uploadRawFile(f.client, f.bucket.id, f.headers, f.data, { retry }),
    ).rejects.toBeInstanceOf(UploadResponseBodyError)
    expect(f.requests).toHaveLength(2)
  })
})
