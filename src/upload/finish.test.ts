import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { FinishLargeFileResponseBodyError, NetworkError } from '../errors/index.ts'
import type { RawClient } from '../raw/index.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import { accountId, bucketId, fileId, largeFileId } from '../types/ids.ts'
import { finishLargeFileWithAbortReconciliation } from './finish.ts'

const accountInfo = {
  getApiUrl: () => 'https://api.example.com',
  getAuthToken: () => 'auth-token',
} as AccountInfo

const finishedFile: FileVersion = {
  accountId: accountId('account'),
  action: FileAction.Upload,
  bucketId: bucketId('bucket'),
  contentLength: 0,
  contentMd5: null,
  contentSha1: null,
  contentType: 'application/octet-stream',
  fileId: fileId('4_z_finished'),
  fileInfo: {},
  fileName: 'finished.bin',
  fileRetention: { isClientAuthorizedToRead: true, value: null },
  legalHold: { isClientAuthorizedToRead: true, value: null },
  replicationStatus: null,
  serverSideEncryption: { mode: 'none' },
  uploadTimestamp: 1,
}

function rawThatFinishes(run: RawClient['finishLargeFile']): RawClient {
  return { finishLargeFile: vi.fn(run) } as unknown as RawClient
}

function finish(raw: RawClient, signal?: AbortSignal): Promise<FileVersion> {
  return finishLargeFileWithAbortReconciliation(raw, accountInfo, {
    fileId: largeFileId('4_z_unfinished'),
    bucketId: bucketId('bucket'),
    fileName: 'finished.bin',
    partSha1s: ['abc'],
    ...(signal !== undefined ? { signal } : {}),
  })
}

describe('finishLargeFileWithAbortReconciliation', () => {
  it('returns the finished file and omits request options when no signal or retry is supplied', async () => {
    const raw = rawThatFinishes(async () => finishedFile)

    await expect(finish(raw)).resolves.toBe(finishedFile)
    expect(raw.finishLargeFile).toHaveBeenCalledWith(
      'https://api.example.com',
      'auth-token',
      {
        fileId: largeFileId('4_z_unfinished'),
        partSha1Array: ['abc'],
      },
      undefined,
    )
  })

  it('passes signal and retry request options when supplied', async () => {
    const controller = new AbortController()
    const retry = { requestTimeoutMs: 2_000 }
    const raw = rawThatFinishes(async () => finishedFile)

    await expect(
      finishLargeFileWithAbortReconciliation(raw, accountInfo, {
        fileId: largeFileId('4_z_unfinished'),
        bucketId: bucketId('bucket'),
        fileName: 'finished.bin',
        partSha1s: ['abc'],
        signal: controller.signal,
        retry,
      }),
    ).resolves.toBe(finishedFile)

    expect(raw.finishLargeFile).toHaveBeenCalledWith(
      'https://api.example.com',
      'auth-token',
      {
        fileId: largeFileId('4_z_unfinished'),
        partSha1Array: ['abc'],
      },
      { signal: controller.signal, retry },
    )
  })

  it('throws before dispatching finish when the caller already aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('already stopped')
    const raw = rawThatFinishes(async () => finishedFile)
    controller.abort(reason)

    await expect(finish(raw, controller.signal)).rejects.toBe(reason)
    expect(raw.finishLargeFile).not.toHaveBeenCalled()
  })

  it('wraps network and timeout finish failures as ambiguous', async () => {
    const timeout = new DOMException('timed out', 'TimeoutError')
    const network = new NetworkError('network lost')

    for (const err of [timeout, network]) {
      const raw = rawThatFinishes(async () => {
        throw err
      })

      await expect(finish(raw)).rejects.toMatchObject({
        fileId: largeFileId('4_z_unfinished'),
        bucketId: bucketId('bucket'),
        fileName: 'finished.bin',
        cause: err,
      })
    }
  })

  it('wraps abort errors after finish dispatch as ambiguous', async () => {
    const controller = new AbortController()
    const raw = rawThatFinishes(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })

    await expect(finish(raw, controller.signal)).rejects.toBeInstanceOf(
      FinishLargeFileResponseBodyError,
    )
  })

  it('wraps named AbortError instances after finish dispatch as ambiguous', async () => {
    const controller = new AbortController()
    const abortError = new Error('aborted by fetch')
    abortError.name = 'AbortError'
    const raw = rawThatFinishes(async () => {
      controller.abort()
      throw abortError
    })

    await expect(finish(raw, controller.signal)).rejects.toMatchObject({ cause: abortError })
  })

  it('wraps the caller abort reason after finish dispatch as ambiguous', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped waiting')
    const raw = rawThatFinishes(async () => {
      controller.abort(reason)
      throw reason
    })

    await expect(finish(raw, controller.signal)).rejects.toMatchObject({ cause: reason })
  })

  it('wraps named TimeoutError instances as ambiguous', async () => {
    const timeout = new Error('timed out by fetch')
    timeout.name = 'TimeoutError'
    const raw = rawThatFinishes(async () => {
      throw timeout
    })

    await expect(finish(raw)).rejects.toMatchObject({ cause: timeout })
  })

  it('rethrows non-ambiguous finish errors unchanged', async () => {
    const err = new Error('validation failed')
    const raw = rawThatFinishes(async () => {
      throw err
    })

    await expect(finish(raw)).rejects.toBe(err)
  })
})
