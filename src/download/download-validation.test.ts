import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient, readStream } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { fileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

function downloadWith(options: { concurrency?: number; rangeSize?: number; totalSize?: number }) {
  const downloadFileById = vi.fn(async () => {
    throw new Error('invalid options reached the transport')
  })
  const raw = { downloadFileById } as unknown as RawClient
  const accountInfo = {
    getDownloadUrl: () => 'https://example.com',
    getAuthToken: () => 'test-auth',
  } as unknown as AccountInfo
  const read = async () =>
    readStream(
      createParallelDownloadStream(raw, accountInfo, {
        fileId: fileId('validation-file'),
        totalSize: 25,
        rangeSize: 25,
        concurrency: 1,
        ...options,
      }),
    )
  return { read, downloadFileById }
}

describe('parallel download option validation', () => {
  it('rejects concurrency 0 instead of silently returning zero bytes', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-validation',
      bucketType: BucketType.AllPrivate,
    })
    const data = deterministicBytes(100)
    const uploaded = await bucket.upload({ fileName: 'f.bin', source: new BufferSource(data) })
    const download = vi.spyOn(client.raw, 'downloadFileById')
    const read = async () =>
      readStream(
        bucket.file('f.bin').createReadStream(uploaded.fileId, data.byteLength, {
          rangeSize: 25,
          concurrency: 0,
        }),
      )

    const result = read()
    await expect(result).rejects.toThrow(RangeError)
    await expect(result).rejects.toThrow(/concurrency must be a positive integer/)
    expect(download).not.toHaveBeenCalled()
  })

  it.each([0, -1, Number.NaN, 1.5, Infinity])(
    'rejects concurrency %s before requesting bytes',
    async (value) => {
      const { read, downloadFileById } = downloadWith({ concurrency: value })
      const result = read()
      await expect(result).rejects.toThrow(RangeError)
      await expect(result).rejects.toThrow(/concurrency must be a positive integer/)
      expect(downloadFileById).not.toHaveBeenCalled()
    },
  )

  it.each([0, -1, Number.NaN])(
    'rejects rangeSize %s even for an empty file before requesting bytes',
    async (value) => {
      // An empty total keeps this regression bounded before the planner validates its input.
      const { read, downloadFileById } = downloadWith({ totalSize: 0, rangeSize: value })
      const result = read()
      await expect(result).rejects.toThrow(RangeError)
      await expect(result).rejects.toThrow(/chunkSize must be a positive number/)
      expect(downloadFileById).not.toHaveBeenCalled()
    },
  )

  it.each([0, -1, Number.NaN])('rejects rangeSize %s for a non-empty file', async (value) => {
    const { read, downloadFileById } = downloadWith({ rangeSize: value })
    const result = read()
    await expect(result).rejects.toThrow(RangeError)
    await expect(result).rejects.toThrow(/chunkSize must be a positive number/)
    expect(downloadFileById).not.toHaveBeenCalled()
  })
})
