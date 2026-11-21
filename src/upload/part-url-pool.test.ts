import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { InMemoryAccountInfo } from '../auth/in-memory.ts'
import { B2Client } from '../client.ts'
import { NetworkError } from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import type { RawClient } from '../raw/index.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { bucketId, largeFileId } from '../types/ids.ts'
import { cancelLargeFileBestEffort } from './cancel.ts'
import { finishLargeFileWithAbortReconciliation } from './finish.ts'
import { uploadLargeFile } from './large.ts'
import { uploadPartWithFreshUrl } from './retry.ts'

describe('part upload URL pool cleanup', () => {
  it('part-upload URLs for a finished large file are not retained in the account pool', async () => {
    // A reduced simulator part size exercises multipart upload with small fixtures.
    const sim = new B2Simulator({ minimumPartSize: 100_000 })
    // The pool is keyed by the large-file id issued by b2_start_large_file. The simulator
    // gives the finished file a different id, so read the key off the start request itself
    // instead of the returned FileVersion or any internal check-in call.
    const inner = sim.transport()
    let startedFileId: string | undefined
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const resp = await inner.send(req)
        if (req.url.includes('b2_start_large_file')) {
          startedFileId = ((await resp.json()) as { fileId: string }).fileId
        }
        return resp
      },
    }
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport,
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'pool-c13',
      bucketType: BucketType.AllPrivate,
    })

    const info = client.accountInfo
    await uploadLargeFile(client.raw, client.accountInfo, {
      bucketId: bucket.id,
      fileName: 'pooled.bin',
      source: new BufferSource(deterministicBytes(300_000)),
      partSize: 100_000,
      concurrency: 2,
    })

    // The large file is finished; its per-file part-URL entries can never be
    // used again, so the pool must not keep them (otherwise it grows per file).
    // Whether the upload checked URLs in or never pooled them is an implementation
    // detail: only the absence of a retained entry is the contract.
    expect(startedFileId, 'b2_start_large_file was never issued').toBeDefined()
    const leaked = info.checkoutPartUploadUrl(startedFileId as string)
    expect(leaked, 'a part upload URL for a finished large file is still pooled').toBeNull()
  })
  it.each([true, false])(
    'handles part URLs after cancellation success=%s without clearing other files',
    async (cancelSucceeds) => {
      // A reduced simulator part size exercises multipart upload with small fixtures.
      const sim = new B2Simulator({ minimumPartSize: 100_000 })
      const inner = sim.transport()
      let startedFileId: string | undefined
      let cancelled = 0
      const transport: HttpTransport = {
        async send(req) {
          if (
            req.url.includes('b2_finish_large_file') ||
            (!cancelSucceeds && req.url.includes('b2_cancel_large_file'))
          ) {
            const body = { status: 400, code: 'bad_request', message: 'finish rejected' }
            return {
              status: 400,
              headers: new Headers(),
              body: null,
              json: async () => body as never,
              text: async () => JSON.stringify(body),
              arrayBuffer: async () => new ArrayBuffer(0),
            }
          }
          const resp = await inner.send(req)
          if (req.url.includes('b2_start_large_file')) {
            startedFileId = ((await resp.json()) as { fileId: string }).fileId
          }
          if (req.url.includes('b2_cancel_large_file') && resp.status === 200) cancelled++
          return resp
        },
      }
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        transport,
      })
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: 'pool-c13-cancel',
        bucketType: BucketType.AllPrivate,
      })
      const unrelated = { uploadUrl: 'https://example.com/other', authorizationToken: 'other' }
      client.accountInfo.returnPartUploadUrl('other-file', unrelated)
      await expect(
        uploadLargeFile(client.raw, client.accountInfo, {
          bucketId: bucket.id,
          fileName: 'cancelled.bin',
          source: new BufferSource(deterministicBytes(300_000)),
          partSize: 100_000,
          concurrency: 2,
        }),
      ).rejects.toThrow('finish rejected')
      expect(cancelled).toBe(cancelSucceeds ? 1 : 0)
      expect(startedFileId).toBeDefined()
      const retained = client.accountInfo.checkoutPartUploadUrl(startedFileId as string)
      if (cancelSucceeds) expect(retained).toBeNull()
      else expect(retained).not.toBeNull()
      expect(client.accountInfo.checkoutPartUploadUrl('other-file')).toEqual(unrelated)
    },
  )

  it('does not return a late part URL after the upload is aborted', async () => {
    const info = new InMemoryAccountInfo()
    const fileId = largeFileId('unfinished-file')
    const entry = { uploadUrl: 'https://example.com/part', authorizationToken: 'test' }
    info.returnPartUploadUrl(fileId, entry)
    let announceStart = () => {}
    const started = new Promise<void>((resolve) => {
      announceStart = resolve
    })
    let releaseUpload = () => {}
    const release = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const raw = {
      async uploadPart() {
        announceStart()
        await release
        return { contentSha1: 'sha1' }
      },
    } as unknown as RawClient
    const controller = new AbortController()
    const pending = uploadPartWithFreshUrl(raw, info, fileId, {
      fileName: 'test',
      partNumber: 1,
      data: new Uint8Array([1]),
      contentLength: 1,
      contentSha1: 'sha1',
      signal: controller.signal,
      retryResponseBodyFailures: false,
      retryUploadConnectionFaults: true,
    })
    await started
    controller.abort()
    releaseUpload()
    await pending
    expect(info.checkoutPartUploadUrl(fileId)).toBeNull()
  })
  it.each(['finish', 'cancel'] as const)(
    'does not return an in-flight part URL after successful %s',
    async (operation) => {
      const info = new InMemoryAccountInfo()
      const fileId = largeFileId('pending-file')
      info.returnPartUploadUrl(fileId, {
        uploadUrl: 'https://example.com/part',
        authorizationToken: 'test',
      })
      let announceStart = () => {}
      const started = new Promise<void>((resolve) => {
        announceStart = resolve
      })
      let releaseUpload = () => {}
      const release = new Promise<void>((resolve) => {
        releaseUpload = resolve
      })
      const raw = {
        async uploadPart() {
          announceStart()
          await release
          return { contentSha1: 'sha1' }
        },
        async finishLargeFile() {
          return { fileId }
        },
        async cancelLargeFile() {
          return { fileId }
        },
      } as unknown as RawClient
      const account = Object.assign(info, {
        getApiUrl: () => 'https://example.com',
        getAuthToken: () => 'test',
      })
      const pending = uploadPartWithFreshUrl(raw, account, fileId, {
        fileName: 'test',
        partNumber: 1,
        data: new Uint8Array([1]),
        contentLength: 1,
        contentSha1: 'sha1',
        retryResponseBodyFailures: false,
        retryUploadConnectionFaults: true,
      })
      await started
      if (operation === 'finish') {
        await finishLargeFileWithAbortReconciliation(raw, account, {
          fileId,
          bucketId: bucketId('bucket'),
          fileName: 'test',
          partSha1s: [],
        })
      } else {
        await cancelLargeFileBestEffort(raw, account, fileId)
      }
      releaseUpload()
      await pending
      expect(account.checkoutPartUploadUrl(fileId)).toBeNull()
    },
  )

  it.each(['throwing', 'non-draining'] as const)(
    'preserves successful finish with a %s custom store',
    async (mode) => {
      let calls = 0
      const account = {
        getApiUrl: () => 'https://example.com',
        getAuthToken: () => 'test',
        checkoutPartUploadUrl: () => {
          calls++
          if (mode === 'throwing') throw new Error('store unavailable')
          return { uploadUrl: 'https://example.com/part', authorizationToken: 'test' }
        },
      } as unknown as AccountInfo
      const result = { fileId: largeFileId('finished-file') }
      const raw = { finishLargeFile: async () => result } as unknown as RawClient
      await expect(
        finishLargeFileWithAbortReconciliation(raw, account, {
          fileId: result.fileId,
          bucketId: bucketId('bucket'),
          fileName: 'test',
          partSha1s: [],
        }),
      ).resolves.toBe(result)
      expect(calls).toBe(mode === 'throwing' ? 1 : 10_000)
    },
  )

  it('clears pooled URLs when a caller cancels a large file through the bucket', async () => {
    const sim = new B2Simulator()
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'pool-c13-public-cancel',
      bucketType: BucketType.AllPrivate,
    })
    const started = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'test',
        contentType: 'application/octet-stream',
      },
    )
    client.accountInfo.returnPartUploadUrl(started.fileId, {
      uploadUrl: 'https://example.com/part',
      authorizationToken: 'test',
    })
    await bucket.cancelLargeFile(started.fileId)
    expect(client.accountInfo.checkoutPartUploadUrl(started.fileId)).toBeNull()
  })

  it('keeps part URLs when the finish outcome is ambiguous', async () => {
    const sim = new B2Simulator()
    const client = new B2Client({
      applicationKeyId: 'test-key-id',
      applicationKey: 'test-key',
      transport: sim.transport(),
    })
    await client.authorize()
    const fileId = largeFileId('ambiguous-file')
    const entry = { uploadUrl: 'https://example.com/part', authorizationToken: 'test' }
    client.accountInfo.returnPartUploadUrl(fileId, entry)
    const raw = {
      finishLargeFile: async () => {
        throw new NetworkError('connection lost')
      },
    } as unknown as RawClient
    await expect(
      finishLargeFileWithAbortReconciliation(raw, client.accountInfo, {
        fileId,
        bucketId: bucketId('bucket'),
        fileName: 'test',
        partSha1s: [],
      }),
    ).rejects.toMatchObject({ fileId, message: expect.stringContaining('ambiguous') })
    expect(client.accountInfo.checkoutPartUploadUrl(fileId)).toEqual(entry)
  })
})
