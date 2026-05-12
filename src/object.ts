import type { Bucket } from './bucket.js'
import type { B2Client } from './client.js'
import { createParallelDownloadStream } from './download/parallel.js'
import { type DownloadResult, downloadByName } from './download/single.js'
import { downloadById } from './download/single.js'
import type { ProgressListener } from './streams/progress.js'
import type { ContentSource } from './streams/source.js'
import type { EncryptionSetting } from './types/encryption.js'
import type { FileVersion } from './types/file.js'
import type { FileId } from './types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.js'
import { uploadLargeFile } from './upload/large.js'
import { uploadSmallFile } from './upload/single.js'

export class B2Object {
  readonly fileName: string
  private readonly client: B2Client
  private readonly bucket: Bucket

  constructor(client: B2Client, bucket: Bucket, fileName: string) {
    this.client = client
    this.bucket = bucket
    this.fileName = fileName
  }

  async upload(options: {
    source: ContentSource
    contentType?: string
    fileInfo?: Record<string, string>
    serverSideEncryption?: EncryptionSetting
    fileRetention?: FileRetentionValue
    legalHold?: LegalHoldValue
    lastModifiedMillis?: number
    partSize?: number
    concurrency?: number
    onProgress?: ProgressListener
    signal?: AbortSignal
  }): Promise<FileVersion> {
    const recommendedPartSize = this.client.accountInfo.getRecommendedPartSize()
    const isLarge = options.source.size > recommendedPartSize

    const baseOpts = {
      bucketId: this.bucket.id,
      fileName: this.fileName,
      ...options,
    }

    return isLarge
      ? uploadLargeFile(this.client.raw, this.client.accountInfo, baseOpts)
      : uploadSmallFile(this.client.raw, this.client.accountInfo, baseOpts)
  }

  async download(options?: {
    range?: string
    signal?: AbortSignal
  }): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.bucket.name,
      fileName: this.fileName,
      ...options,
    })
  }

  async downloadById(
    fileId: FileId,
    options?: {
      range?: string
      signal?: AbortSignal
    },
  ): Promise<DownloadResult> {
    return downloadById(this.client.raw, this.client.accountInfo, {
      fileId,
      ...options,
    })
  }

  createReadStream(
    fileId: FileId,
    totalSize: number,
    options?: {
      rangeSize?: number
      concurrency?: number
      signal?: AbortSignal
    },
  ): ReadableStream<Uint8Array> {
    return createParallelDownloadStream(this.client.raw, this.client.accountInfo, {
      fileId,
      totalSize,
      ...options,
    })
  }

  async getFileInfo(fileId: FileId): Promise<FileVersion> {
    return this.client.raw.getFileInfo(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileId },
    )
  }

  async hide(): Promise<FileVersion> {
    return this.bucket.hideFile(this.fileName)
  }

  async deleteVersion(fileId: FileId): Promise<void> {
    await this.bucket.deleteFileVersion(this.fileName, fileId)
  }
}
