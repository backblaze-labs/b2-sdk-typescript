import type { B2Client } from './client.js'
import { type DownloadResult, downloadByName } from './download/single.js'
import { B2Object } from './object.js'
import type { ProgressListener } from './streams/progress.js'
import type { ContentSource } from './streams/source.js'
import type {
  BucketInfo,
  BucketRetentionPolicy,
  BucketType,
  CorsRule,
  LifecycleRule,
} from './types/bucket.js'
import type { DownloadAuthorizationResponse } from './types/download.js'
import type { EncryptionSetting } from './types/encryption.js'
import type {
  FileVersion,
  ListFileNamesResponse,
  ListFileVersionsResponse,
  MetadataDirective,
} from './types/file.js'
import type { BucketId, FileId } from './types/ids.js'
import { accountId } from './types/ids.js'
import type { FileRetentionValue, LegalHoldValue } from './types/lock.js'
import type {
  EventNotificationRule,
  GetBucketNotificationRulesResponse,
} from './types/notifications.js'
import type { ReplicationConfiguration } from './types/replication.js'
import { uploadLargeFile } from './upload/large.js'
import { uploadSmallFile } from './upload/single.js'

export class Bucket {
  readonly id: BucketId
  readonly name: string
  readonly info: BucketInfo
  private readonly client: B2Client

  constructor(client: B2Client, info: BucketInfo) {
    this.client = client
    this.info = info
    this.id = info.bucketId
    this.name = info.bucketName
  }

  file(fileName: string): B2Object {
    return new B2Object(this.client, this, fileName)
  }

  // --- Upload ---

  async upload(options: {
    fileName: string
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

    if (isLarge) {
      return uploadLargeFile(this.client.raw, this.client.accountInfo, {
        bucketId: this.id,
        ...options,
      })
    }

    return uploadSmallFile(this.client.raw, this.client.accountInfo, {
      bucketId: this.id,
      ...options,
    })
  }

  // --- Download ---

  async download(
    fileName: string,
    options?: {
      range?: string
      signal?: AbortSignal
    },
  ): Promise<DownloadResult> {
    return downloadByName(this.client.raw, this.client.accountInfo, {
      bucketName: this.name,
      fileName,
      ...options,
    })
  }

  // --- List ---

  async listFileNames(options?: {
    startFileName?: string
    maxFileCount?: number
    prefix?: string
    delimiter?: string
  }): Promise<ListFileNamesResponse> {
    return this.client.raw.listFileNames(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        bucketId: this.id,
        ...(options?.startFileName !== undefined ? { startFileName: options.startFileName } : {}),
        ...(options?.maxFileCount !== undefined ? { maxFileCount: options.maxFileCount } : {}),
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      },
    )
  }

  async listFileVersions(options?: {
    startFileName?: string
    startFileId?: FileId
    maxFileCount?: number
    prefix?: string
    delimiter?: string
  }): Promise<ListFileVersionsResponse> {
    return this.client.raw.listFileVersions(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, ...options },
    )
  }

  async *listAllFiles(options?: {
    prefix?: string
    delimiter?: string
    pageSize?: number
  }): AsyncGenerator<FileVersion> {
    let startFileName: string | undefined
    for (;;) {
      const resp = await this.listFileNames({
        ...(startFileName !== undefined ? { startFileName } : {}),
        maxFileCount: options?.pageSize ?? 1000,
        ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
        ...(options?.delimiter !== undefined ? { delimiter: options.delimiter } : {}),
      })
      for (const file of resp.files) {
        yield file
      }
      if (!resp.nextFileName) break
      startFileName = resp.nextFileName
    }
  }

  // --- File operations ---

  async hideFile(fileName: string): Promise<FileVersion> {
    return this.client.raw.hideFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileName },
    )
  }

  async deleteFileVersion(fileName: string, fileId: FileId): Promise<void> {
    await this.client.raw.deleteFileVersion(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId },
    )
  }

  async copyFile(options: {
    sourceFileId: FileId
    fileName: string
    destinationBucketId?: BucketId
    metadataDirective?: MetadataDirective
    contentType?: string
    fileInfo?: Record<string, string>
    serverSideEncryption?: EncryptionSetting
  }): Promise<FileVersion> {
    return this.client.raw.copyFile(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      options,
    )
  }

  // --- Bucket management ---

  async update(options: {
    bucketType?: BucketType
    bucketInfo?: Record<string, string>
    corsRules?: CorsRule[]
    defaultServerSideEncryption?: EncryptionSetting
    defaultRetention?: BucketRetentionPolicy
    lifecycleRules?: LifecycleRule[]
    replicationConfiguration?: ReplicationConfiguration
    ifRevisionIs?: number
  }): Promise<BucketInfo> {
    return this.client.raw.updateBucket(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      {
        accountId: accountId(this.client.accountInfo.getAccountId()),
        bucketId: this.id,
        ...options,
      },
    )
  }

  async delete(): Promise<BucketInfo> {
    return this.client.deleteBucket(this.id)
  }

  // --- Auth ---

  async getDownloadAuthorization(
    fileNamePrefix: string,
    validDurationInSeconds: number,
  ): Promise<DownloadAuthorizationResponse> {
    return this.client.raw.getDownloadAuthorization(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, fileNamePrefix, validDurationInSeconds },
    )
  }

  // --- Notifications ---

  async getNotificationRules(): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.getBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id },
    )
  }

  async setNotificationRules(
    rules: EventNotificationRule[],
  ): Promise<GetBucketNotificationRulesResponse> {
    return this.client.raw.setBucketNotificationRules(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { bucketId: this.id, eventNotificationRules: rules },
    )
  }

  // --- Retention / Legal Hold ---

  async updateFileRetention(fileName: string, fileId: FileId, retention: FileRetentionValue) {
    return this.client.raw.updateFileRetention(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId, fileRetention: retention },
    )
  }

  async updateFileLegalHold(fileName: string, fileId: FileId, legalHold: LegalHoldValue) {
    return this.client.raw.updateFileLegalHold(
      this.client.accountInfo.getApiUrl(),
      this.client.accountInfo.getAuthToken(),
      { fileName, fileId, legalHold },
    )
  }
}
