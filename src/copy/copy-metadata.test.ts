import { describe, expect, it, vi } from 'vitest'
import { BufferSource } from '../streams/source.ts'
import { deterministicBytes } from '../test-utils/index.ts'
import { makeRemoteClient } from '../test-utils/remote-simulator.ts'
import { BucketType } from '../types/bucket.ts'
import { copyLargeFile } from './large.ts'

describe('multipart copy metadata', () => {
  it.each([
    ['inherits source fileInfo when none is supplied', undefined],
    ['uses explicit replacement fileInfo', { replacement: 'only' }],
    ['uses an explicitly empty replacement fileInfo', {}],
  ] as const)('%s', async (_name, replacement) => {
    // Small simulator parts exercise multipart behavior without multi-MB fixtures.
    const { client } = await makeRemoteClient({ minimumPartSize: 100_000 })
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
    const expectedInfo = { ...(replacement ?? uploaded.fileInfo) }
    const copyPart = vi.spyOn(client.raw, 'copyPart')

    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'dst.bin',
      partSize: 100_000,
      concurrency: 1,
      ...(replacement !== undefined ? { fileInfo: replacement } : {}),
    })

    expect(copyPart).toHaveBeenCalledTimes(2)
    expect(copied.fileInfo).toEqual(expectedInfo)
    const stored = await client.raw.getFileInfo(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: copied.fileId },
    )
    expect(stored.fileInfo).toEqual(expectedInfo)
  })

  it('preserves source fileInfo on a small copy with only a contentType override', async () => {
    const { client } = await makeRemoteClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'copy-small-metadata',
      bucketType: BucketType.AllPrivate,
    })
    const sourceInfo = { 'src-tag': 'keep-me' }
    const uploaded = await bucket.upload({
      fileName: 'src.txt',
      source: new BufferSource(new TextEncoder().encode('small source')),
      contentType: 'application/octet-stream',
      fileInfo: sourceInfo,
    })
    const copyPart = vi.spyOn(client.raw, 'copyPart')

    const copied = await copyLargeFile(client.raw, client.accountInfo, {
      sourceFileId: uploaded.fileId,
      fileName: 'dst.txt',
      contentType: 'text/plain',
    })

    expect(copyPart).not.toHaveBeenCalled()
    expect(copied.contentType).toBe('text/plain')
    expect(copied.fileInfo).toEqual(sourceInfo)
    const stored = await client.raw.getFileInfo(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: copied.fileId },
    )
    expect(stored.contentType).toBe('text/plain')
    expect(stored.fileInfo).toEqual(sourceInfo)
  })
})
