import type { AccountInfo } from '../auth/account-info.js'
import type { RawClient } from '../raw/index.js'
import { IncrementalSha1 } from '../streams/hash.js'
import type { ProgressListener } from '../streams/progress.js'
import { ProgressTracker } from '../streams/progress.js'
import type { ContentSource } from '../streams/source.js'
import type { EncryptionSetting } from '../types/encryption.js'
import type { FileVersion } from '../types/file.js'
import type { BucketId, LargeFileId } from '../types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.js'
import { Semaphore } from './concurrency.js'

export interface UploadLargeFileOptions {
  readonly bucketId: BucketId
  readonly fileName: string
  readonly source: ContentSource
  readonly contentType?: string
  readonly fileInfo?: Record<string, string>
  readonly serverSideEncryption?: EncryptionSetting
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
  readonly partSize?: number
  readonly concurrency?: number
  readonly onProgress?: ProgressListener
  readonly signal?: AbortSignal
}

interface PartPlan {
  readonly partNumber: number
  readonly offset: number
  readonly length: number
}

export async function uploadLargeFile(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadLargeFileOptions,
): Promise<FileVersion> {
  const recommendedPartSize = accountInfo.getRecommendedPartSize()
  const minPartSize = accountInfo.getAbsoluteMinimumPartSize()
  const partSize = Math.max(options.partSize ?? recommendedPartSize, minPartSize)
  const concurrency = options.concurrency ?? 4
  const totalSize = options.source.size

  const parts = planParts(totalSize, partSize)
  const fileInfo: Record<string, string> = { ...options.fileInfo }

  const startResp = await raw.startLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
    bucketId: options.bucketId,
    fileName: options.fileName,
    contentType: options.contentType ?? 'b2/x-auto',
    fileInfo,
    ...(options.serverSideEncryption !== undefined
      ? { serverSideEncryption: options.serverSideEncryption }
      : {}),
    ...(options.fileRetention !== undefined ? { fileRetention: options.fileRetention } : {}),
    ...(options.legalHold !== undefined ? { legalHold: options.legalHold } : {}),
  })

  const largeFileId = startResp.fileId

  const partSha1s: string[] = new Array(parts.length)
  const wholeSha1 = new IncrementalSha1()
  const tracker = new ProgressTracker(options.onProgress, totalSize, parts.length)
  const sem = new Semaphore(concurrency)

  try {
    const tasks = parts.map(async (part) => {
      await sem.acquire()
      try {
        options.signal?.throwIfAborted()

        const partSource = options.source.slice(part.offset, part.offset + part.length)
        const data = new Uint8Array(await partSource.toArrayBuffer())

        const partSha1 = new IncrementalSha1()
        await partSha1.update(data)
        const sha1Hex = await partSha1.digest()

        let uploadEntry = accountInfo.checkoutPartUploadUrl(largeFileId as string)
        if (!uploadEntry) {
          const resp = await raw.getUploadPartUrl(
            accountInfo.getApiUrl(),
            accountInfo.getAuthToken(),
            { fileId: largeFileId },
          )
          uploadEntry = { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
        }

        try {
          const result = await raw.uploadPart(
            uploadEntry.uploadUrl,
            {
              authorization: uploadEntry.authorizationToken,
              partNumber: part.partNumber,
              contentLength: data.byteLength,
              contentSha1: sha1Hex,
              ...(options.serverSideEncryption !== undefined
                ? { serverSideEncryption: options.serverSideEncryption }
                : {}),
            },
            data,
            options.signal,
          )

          accountInfo.returnPartUploadUrl(largeFileId as string, uploadEntry)
          partSha1s[part.partNumber - 1] = result.contentSha1
          tracker.addBytes(data.byteLength)
          tracker.completePart()
        } catch (err) {
          accountInfo.evictPartUploadUrl(largeFileId as string, uploadEntry)
          throw err
        }
      } finally {
        sem.release()
      }
    })

    await Promise.all(tasks)

    const result = await raw.finishLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId: largeFileId,
      partSha1Array: partSha1s,
    })

    return result
  } catch (err) {
    try {
      await raw.cancelLargeFile(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
        fileId: largeFileId,
      })
    } catch {
      // Best-effort cleanup
    }
    throw err
  }
}

function planParts(totalSize: number, partSize: number): PartPlan[] {
  const parts: PartPlan[] = []
  let offset = 0
  let partNumber = 1
  while (offset < totalSize) {
    const length = Math.min(partSize, totalSize - offset)
    parts.push({ partNumber, offset, length })
    offset += length
    partNumber++
  }
  return parts
}
