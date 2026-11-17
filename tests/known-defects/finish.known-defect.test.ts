// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../../src/auth/account-info.ts'
import {
  FinishLargeFileResponseBodyError,
  ServiceUnavailableError,
} from '../../src/errors/index.ts'
import type { RawClient } from '../../src/raw/index.ts'
import { bucketId, largeFileId } from '../../src/types/ids.ts'
import { finishLargeFileWithAbortReconciliation } from '../../src/upload/finish.ts'

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
