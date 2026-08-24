/**
 * Live endpoint contract coverage against a real Backblaze B2 account.
 *
 * Requires env vars:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { createNativeDownloadAuthorizationUrl } from '../../src/s3/index.ts'
import { sha1Hex } from '../../src/streams/hash.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { DownloadHeaderName } from '../../src/types/download.ts'
import { EncryptionKey } from '../../src/types/encryption.ts'
import type { FileVersion } from '../../src/types/file.ts'
import type { LargeFileId } from '../../src/types/ids.ts'
import type { UploadPartResponse } from '../../src/types/upload.ts'
import { uploadPartWithFreshUrl } from '../../src/upload/retry.ts'
import { hasB2ErrorCode } from '../helpers/b2-cleanup.ts'
import {
  appKey,
  concatBytes,
  deleteBucketIfPresent,
  expectBytesEqual,
  fetchBytesWithDeadline,
  keyId,
  makeBucketName,
  makeBytes,
  readAllBytes,
  readRequiredBody,
  requireB2IntegrationCredentials,
  setupStep,
  skipB2Integration as skip,
  sweepStaleIntegrationBuckets,
} from '../helpers/live-b2.ts'

requireB2IntegrationCredentials()

const runToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function fileName(label: string): string {
  return `multipart/${label}-${runToken}.bin`
}

function hasStatus(err: unknown, status: number): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { readonly status?: unknown }).status === status
  )
}

async function uploadRawPart(
  client: B2Client,
  largeFileId: LargeFileId,
  fileName: string,
  partNumber: number,
  data: Uint8Array,
): Promise<UploadPartResponse> {
  const contentSha1 = await sha1Hex(data)
  const uploaded = await uploadPartWithFreshUrl(client.raw, client.accountInfo, largeFileId, {
    fileName,
    partNumber,
    data: data as BodyInit,
    contentLength: data.byteLength,
    contentSha1,
    retryResponseBodyFailures: true,
  })

  expect(uploaded.fileId).toBe(largeFileId)
  expect(uploaded.partNumber).toBe(partNumber)
  expect(uploaded.contentLength).toBe(data.byteLength)
  expect(uploaded.contentSha1).toBe(contentSha1)
  return uploaded
}

async function expectWrongSha1PartRejected(
  client: B2Client,
  largeFileId: LargeFileId,
  data: Uint8Array,
): Promise<void> {
  const uploadUrl = await client.raw.getUploadPartUrl(
    client.accountInfo.getApiUrl(),
    client.accountInfo.getAuthToken(),
    { fileId: largeFileId },
  )

  let uploadError: unknown
  try {
    await client.raw.uploadPart(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        partNumber: 1,
        contentLength: data.byteLength,
        contentSha1: '0'.repeat(40),
      },
      data as BodyInit,
    )
  } catch (err) {
    uploadError = err
  }

  expect(uploadError).toBeDefined()
  expect(
    hasB2ErrorCode(uploadError, 'bad_request') ||
      hasB2ErrorCode(uploadError, 'checksum_mismatch') ||
      hasStatus(uploadError, 400),
  ).toBe(true)

  const listed = await client.raw.listParts(
    client.accountInfo.getApiUrl(),
    client.accountInfo.getAuthToken(),
    { fileId: largeFileId, maxPartCount: 100 },
  )
  expect(listed.parts).toHaveLength(0)
  expect(listed.nextPartNumber).toBeNull()
}

async function createRawMultipartFile(
  client: B2Client,
  bucket: Bucket,
  name: string,
  parts: readonly Uint8Array[],
  options?: { readonly assertWrongSha1Rejection?: boolean },
): Promise<{
  readonly file: FileVersion
  readonly data: Uint8Array
  readonly partSha1s: string[]
}> {
  const started = await client.raw.startLargeFile(
    client.accountInfo.getApiUrl(),
    client.accountInfo.getAuthToken(),
    {
      bucketId: bucket.id,
      fileName: name,
      contentType: 'application/octet-stream',
      fileInfo: {},
    },
  )
  let finished = false

  try {
    if (options?.assertWrongSha1Rejection === true) {
      await expectWrongSha1PartRejected(client, started.fileId, parts[0] ?? new Uint8Array())
    }

    const uploadedParts: UploadPartResponse[] = []
    for (let i = 0; i < parts.length; i++) {
      uploadedParts.push(
        await uploadRawPart(client, started.fileId, name, i + 1, parts[i] ?? new Uint8Array()),
      )
    }
    const partSha1s = uploadedParts.map((part) => part.contentSha1)

    const listed = await client.raw.listParts(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: started.fileId, maxPartCount: 100 },
    )
    expect(listed.nextPartNumber).toBeNull()
    expect(listed.parts.map((part) => part.partNumber)).toEqual(
      parts.map((_part, index) => index + 1),
    )
    expect(listed.parts.map((part) => part.contentLength)).toEqual(
      parts.map((part) => part.byteLength),
    )
    expect(listed.parts.map((part) => part.contentSha1)).toEqual(partSha1s)

    const file = await client.raw.finishLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: started.fileId, partSha1Array: partSha1s },
    )
    finished = true

    const data = concatBytes(parts)
    expect(file.fileId).toBe(started.fileId)
    expect(file.fileName).toBe(name)
    expect(file.contentLength).toBe(data.byteLength)
    return { file, data, partSha1s }
  } finally {
    if (!finished) {
      await client.raw
        .cancelLargeFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
          fileId: started.fileId,
        })
        .catch(() => {})
    }
  }
}

describe.skipIf(skip)('B2 live endpoint integration contracts', () => {
  let client: B2Client
  let bucket: Bucket
  const bucketName = makeBucketName('contracts')

  beforeAll(async () => {
    client = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await setupStep('authorize', () => client.authorize())

    const existing = await setupStep('list buckets', () => client.listBuckets())
    await setupStep('sweep stale integration buckets', () => sweepStaleIntegrationBuckets(existing))

    bucket = await setupStep(`create bucket ${bucketName}`, () =>
      client.createBucket({
        bucketName,
        bucketType: 'allPrivate',
      }),
    )
  })

  afterAll(async () => {
    if (!bucket) return
    await deleteBucketIfPresent(bucket)
  })

  describe('multipart assembly and copy', () => {
    it('assembles a multipart file with raw part endpoints and byte-exact download', async () => {
      const firstPart = makeBytes(client.accountInfo.getAbsoluteMinimumPartSize() + 1024, 17)
      const secondPart = makeBytes(1024 * 1024, 41)
      expect(firstPart.byteLength).toBeGreaterThan(5_000_000)
      const { file, data } = await createRawMultipartFile(
        client,
        bucket,
        fileName('assembled'),
        [firstPart, secondPart],
        { assertWrongSha1Rejection: true },
      )

      const downloaded = await bucket.download(file.fileName)
      expect(downloaded.headers.fileId).toBe(file.fileId)
      expect(downloaded.headers.contentLength).toBe(data.byteLength)
      expectBytesEqual(await readAllBytes(downloaded.body), data)
    })

    it('copies a large file with copy_part and matches download by id and name', async () => {
      const firstPart = makeBytes(client.accountInfo.getAbsoluteMinimumPartSize() + 2048, 53)
      const secondPart = makeBytes(512 * 1024, 67)
      const source = await createRawMultipartFile(client, bucket, fileName('copy-source'), [
        firstPart,
        secondPart,
      ])

      const copyPart = vi.spyOn(client.raw, 'copyPart')
      try {
        const copied = await bucket.copyLargeFile({
          sourceFileId: source.file.fileId,
          fileName: fileName('copy-destination'),
          partSize: client.accountInfo.getAbsoluteMinimumPartSize(),
          concurrency: 2,
        })

        expect(copyPart).toHaveBeenCalledTimes(2)
        expect(copied.contentLength).toBe(source.data.byteLength)

        const byId = await client.raw.downloadFileById(
          client.accountInfo.getDownloadUrl(),
          client.accountInfo.getAuthToken(),
          copied.fileId,
        )
        const byName = await client.raw.downloadFileByName(
          client.accountInfo.getDownloadUrl(),
          client.accountInfo.getAuthToken(),
          bucket.name,
          copied.fileName,
        )

        expect(byId.status).toBe(200)
        expect(byName.status).toBe(200)
        const byIdBytes = await readRequiredBody(byId.body)
        const byNameBytes = await readRequiredBody(byName.body)
        expectBytesEqual(byIdBytes, source.data)
        expectBytesEqual(byNameBytes, source.data)
        expectBytesEqual(byIdBytes, byNameBytes)
      } finally {
        copyPart.mockRestore()
      }
    })
  })

  describe('encryption and scoped download', () => {
    it('uploads and downloads SSE-C bytes with echoed customer headers', async () => {
      const data = makeBytes(64 * 1024, 83)
      const name = fileName('sse-c')
      const key = await EncryptionKey.fromBytes(makeBytes(32, 97))
      const contentSha1 = await sha1Hex(data)
      const uploadUrl = await client.raw.getUploadUrl(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id },
      )

      const uploaded = await client.raw.uploadFile(
        uploadUrl.uploadUrl,
        {
          authorization: uploadUrl.authorizationToken,
          fileName: name,
          contentType: 'application/octet-stream',
          contentLength: data.byteLength,
          contentSha1,
          serverSideEncryption: key,
        },
        data as BodyInit,
      )

      expect(uploaded.fileName).toBe(name)
      expect(uploaded.contentSha1).toBe(contentSha1)
      expect(uploaded.serverSideEncryption).toMatchObject({ mode: 'SSE-C', algorithm: 'AES256' })

      const downloaded = await client.raw.downloadFileByName(
        client.accountInfo.getDownloadUrl(),
        client.accountInfo.getAuthToken(),
        bucket.name,
        name,
        { serverSideEncryption: key },
      )

      expect(downloaded.status).toBe(200)
      expect(downloaded.headers.get(DownloadHeaderName.ServerSideEncryptionCustomerAlgorithm)).toBe(
        'AES256',
      )
      expect(downloaded.headers.get(DownloadHeaderName.ServerSideEncryptionCustomerKeyMd5)).toBe(
        key.customerKeyMd5,
      )
      expectBytesEqual(await readRequiredBody(downloaded.body), data)
    })

    it('uses a download authorization token to fetch scoped bytes', async () => {
      const data = makeBytes(32 * 1024, 109)
      const name = fileName('download-auth')
      await bucket.upload({
        fileName: name,
        source: new BufferSource(data),
        contentType: 'application/octet-stream',
      })

      const auth = await client.raw.getDownloadAuthorization(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        {
          bucketId: bucket.id,
          fileNamePrefix: name,
          validDurationInSeconds: 60,
        },
      )

      expect(auth.bucketId).toBe(bucket.id)
      expect(auth.fileNamePrefix).toBe(name)
      expect(auth.authorizationToken).toBeTruthy()

      const url = createNativeDownloadAuthorizationUrl(
        client.accountInfo.getDownloadUrl(),
        bucket.name,
        name,
        auth.authorizationToken,
        60,
      )
      const fetched = await fetchBytesWithDeadline(url)
      expect(fetched.status).toBe(200)
      expectBytesEqual(fetched.bytes, data)
    })
  })
})
