import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { jsonResponse, readStream } from '../test-utils/index.ts'
import { EncryptionAlgorithm } from '../types/encryption.ts'
import type { FileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

describe('createParallelDownloadStream Node diagnostics', () => {
  it('redacts SSE-C keys from Node inspect of raw range options', async () => {
    const fakeFileId = 'parallel_sse_c_inspect'
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
        return jsonResponse(
          {
            status: 503,
            code: 'service_unavailable',
            message: 'temporary failure',
          },
          503,
        )
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

    await expect(readStream(stream)).rejects.toThrow(/temporary failure/)

    expect(seenOptions).toHaveLength(1)
    const diagnostics = inspect(seenOptions[0])
    expect(diagnostics).not.toContain(serverSideEncryption.customerKey)
    expect(diagnostics).not.toContain(serverSideEncryption.customerKeyMd5)
    expect(diagnostics).toContain('[redacted SSE-C key]')
  })
})
