import type { AuthorizeAccountResponse } from '../types/auth.js'
import type { BucketId } from '../types/ids.js'

export interface UploadUrlEntry {
  readonly uploadUrl: string
  readonly authorizationToken: string
}

export interface AccountInfo {
  setAuth(auth: AuthorizeAccountResponse): void
  getAuth(): AuthorizeAccountResponse | null
  clear(): void

  getApiUrl(): string
  getDownloadUrl(): string
  getAuthToken(): string
  getAccountId(): string
  getRecommendedPartSize(): number
  getAbsoluteMinimumPartSize(): number
  getS3ApiUrl(): string
  getAllowedBucketId(): BucketId | null

  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null
  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void
  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void

  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null
  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void
  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void
}
