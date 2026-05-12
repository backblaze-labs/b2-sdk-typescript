import type { AccountInfo } from '../auth/account-info.js'
import type { RawClient } from '../raw/index.js'
import { IncrementalSha1 } from '../streams/hash.js'
import type { ProgressListener } from '../streams/progress.js'
import type { ContentSource } from '../streams/source.js'
import type { EncryptionSetting } from '../types/encryption.js'
import type { FileVersion } from '../types/file.js'
import type { BucketId } from '../types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.js'

export interface UploadFileOptions {
  readonly bucketId: BucketId
  readonly fileName: string
  readonly source: ContentSource
  readonly contentType?: string
  readonly fileInfo?: Record<string, string>
  readonly serverSideEncryption?: EncryptionSetting
  readonly fileRetention?: FileRetentionValue
  readonly legalHold?: LegalHoldValue
  readonly lastModifiedMillis?: number
  readonly onProgress?: ProgressListener
  readonly signal?: AbortSignal
}

export async function uploadSmallFile(
  raw: RawClient,
  accountInfo: AccountInfo,
  options: UploadFileOptions,
): Promise<FileVersion> {
  let uploadEntry = accountInfo.checkoutUploadUrl(options.bucketId)

  if (!uploadEntry) {
    const resp = await raw.getUploadUrl(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      bucketId: options.bucketId,
    })
    uploadEntry = { uploadUrl: resp.uploadUrl, authorizationToken: resp.authorizationToken }
  }

  const data = new Uint8Array(await options.source.toArrayBuffer())
  const sha1 = new IncrementalSha1()
  await sha1.update(data)
  const sha1Hex = await sha1.digest()

  try {
    const result = await raw.uploadFile(
      uploadEntry.uploadUrl,
      {
        authorization: uploadEntry.authorizationToken,
        fileName: options.fileName,
        contentType: options.contentType ?? 'b2/x-auto',
        contentLength: data.byteLength,
        contentSha1: sha1Hex,
        ...(options.fileInfo !== undefined ? { fileInfo: options.fileInfo } : {}),
        ...(options.serverSideEncryption !== undefined
          ? { serverSideEncryption: options.serverSideEncryption }
          : {}),
        ...(options.fileRetention !== undefined ? { fileRetention: options.fileRetention } : {}),
        ...(options.legalHold !== undefined ? { legalHold: options.legalHold } : {}),
        ...(options.lastModifiedMillis !== undefined
          ? { lastModifiedMillis: options.lastModifiedMillis }
          : {}),
      },
      data,
      options.signal,
    )

    accountInfo.returnUploadUrl(options.bucketId, uploadEntry)
    return result
  } catch (err) {
    accountInfo.evictUploadUrl(options.bucketId, uploadEntry)
    throw err
  }
}
