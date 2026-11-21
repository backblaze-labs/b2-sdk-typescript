import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import { FinishLargeFileResponseBodyError, ServiceUnavailableError } from '../errors/index.ts'
import type { RawClient } from '../raw/index.ts'
import { bucketId, largeFileId } from '../types/ids.ts'
import { finishLargeFileWithAbortReconciliation } from './finish.ts'

const accountInfo = {
  getApiUrl: () => 'https://api.example.com',
  getAuthToken: () => 'auth-token',
} as AccountInfo

describe('finishLargeFileWithAbortReconciliation', () => {
  it('a 5xx from b2_finish_large_file is ambiguous (not a definite failure that cancels)', async () => {
    const raw = {
      finishLargeFile: vi.fn(async () => {
        throw new ServiceUnavailableError({
          status: 503,
          code: 'service_unavailable',
          message: 'try later',
        })
      }),
    } as unknown as RawClient

    await expect(
      finishLargeFileWithAbortReconciliation(raw, accountInfo, {
        fileId: largeFileId('4_z_unfinished'),
        bucketId: bucketId('bucket'),
        fileName: 'finished.bin',
        partSha1s: ['abc'],
      }),
    ).rejects.toBeInstanceOf(FinishLargeFileResponseBodyError)
  })
})
