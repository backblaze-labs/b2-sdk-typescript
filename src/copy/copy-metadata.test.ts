import { describe, expect, it, vi } from 'vitest'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes, makeClient } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { copyLargeFile } from './large.ts'

describe('multipart copy metadata', () => {
  it.each([
    ['inherits source fileInfo when none is supplied', undefined],
    ['uses explicit replacement fileInfo', { replacement: 'only' }],
    ['uses an explicitly empty replacement fileInfo', {}],
  ] as const)('%s', async (_name, replacement) => {
    const { client } = makeClient({ minimumPartSize: 100_000 })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-metadata',
      bucketType: BucketType.AllPrivate,
    })
    const sourceInfo = { 'src-tag': 'keep-me', src_last_modified_millis: '1700000000000' }
    const uploaded = await bucket.upload({
      fileName: 'src.bin',
      source: new BufferSource(deterministicBytes(200_000)),
      partSize: 100_000,
      concurrency: 1,
      fileInfo: sourceInfo,
    })
    expect(uploaded.fileInfo).toMatchObject(sourceInfo)
    const copyPart = vi.spyOn(client.raw, 'copyPart')

    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'dst.bin',
      partSize: 100_000,
      concurrency: 1,
      ...(replacement !== undefined ? { fileInfo: replacement } : {}),
    })

    const expectedInfo = replacement ?? uploaded.fileInfo
    expect(copyPart).toHaveBeenCalledTimes(2)
    expect(copied.fileInfo).toEqual(expectedInfo)
    const stored = await client.raw.getFileInfo(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: copied.fileId },
    )
    expect(stored.fileInfo).toEqual(expectedInfo)
  })
})
