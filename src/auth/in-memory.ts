import type { AuthorizeAccountResponse } from '../types/auth.js'
import type { BucketId } from '../types/ids.js'
import type { AccountInfo, UploadUrlEntry } from './account-info.js'
import { UploadUrlPool } from './upload-url-pool.js'

export class InMemoryAccountInfo implements AccountInfo {
  private auth: AuthorizeAccountResponse | null = null
  private readonly uploadUrls = new UploadUrlPool()
  private readonly partUploadUrls = new UploadUrlPool()

  setAuth(auth: AuthorizeAccountResponse): void {
    this.auth = auth
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  getAuth(): AuthorizeAccountResponse | null {
    return this.auth
  }

  clear(): void {
    this.auth = null
    this.uploadUrls.clear()
    this.partUploadUrls.clear()
  }

  getApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.apiUrl
  }

  getDownloadUrl(): string {
    return this.requireAuth().apiInfo.storageApi.downloadUrl
  }

  getAuthToken(): string {
    return this.requireAuth().authorizationToken as string
  }

  getAccountId(): string {
    return this.requireAuth().accountId as string
  }

  getRecommendedPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.recommendedPartSize
  }

  getAbsoluteMinimumPartSize(): number {
    return this.requireAuth().apiInfo.storageApi.absoluteMinimumPartSize
  }

  getS3ApiUrl(): string {
    return this.requireAuth().apiInfo.storageApi.s3ApiUrl
  }

  getAllowedBucketId(): BucketId | null {
    return this.requireAuth().apiInfo.storageApi.allowed.bucketId ?? null
  }

  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null {
    return this.uploadUrls.checkout(bucketId as string)
  }

  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.checkin(bucketId as string, entry)
  }

  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.uploadUrls.evict(bucketId as string, entry)
  }

  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null {
    return this.partUploadUrls.checkout(fileId)
  }

  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.checkin(fileId, entry)
  }

  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.partUploadUrls.evict(fileId, entry)
  }

  private requireAuth(): AuthorizeAccountResponse {
    if (!this.auth) throw new Error('Not authorized. Call authorize() first.')
    return this.auth
  }
}
