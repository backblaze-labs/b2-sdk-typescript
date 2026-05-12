/**
 * @packageDocumentation
 * Public type definitions for the B2 SDK.
 * Re-exports all branded IDs, request/response interfaces, and configuration types.
 */

export type {
  AccountId,
  ApplicationKeyId,
  AuthToken,
  Brand,
  BrandTag,
  BucketId,
  FileId,
  KeyId,
  LargeFileId,
  UploadAuthToken,
  UploadUrl,
} from './ids.ts'
export { accountId, applicationKeyId, bucketId, fileId, keyId } from './ids.ts'

export type {
  AllowedInfo,
  ApiInfo,
  AuthorizeAccountRequest,
  AuthorizeAccountResponse,
  Capability,
  GroupsApiInfo,
  StorageApiInfo,
} from './auth.ts'

export type {
  BucketInfo,
  BucketRetentionMode,
  BucketRetentionPolicy,
  BucketType,
  RetentionPeriod,
  CorsRule,
  CreateBucketRequest,
  DeleteBucketRequest,
  LifecycleRule,
  ListBucketsRequest,
  ListBucketsResponse,
  UpdateBucketRequest,
} from './bucket.ts'

export type {
  CopyFileRequest,
  CopyPartRequest,
  CopyPartResponse,
  DeleteFileVersionRequest,
  DeleteFileVersionResponse,
  FileAction,
  FileVersion,
  GetFileInfoRequest,
  HideFileRequest,
  ListFileNamesRequest,
  ListFileNamesResponse,
  ListFileVersionsRequest,
  ListFileVersionsResponse,
  MetadataDirective,
} from './file.ts'

export type {
  CancelLargeFileRequest,
  CancelLargeFileResponse,
  FinishLargeFileRequest,
  GetUploadPartUrlRequest,
  GetUploadPartUrlResponse,
  GetUploadUrlRequest,
  GetUploadUrlResponse,
  ListPartsRequest,
  ListPartsResponse,
  ListUnfinishedLargeFilesRequest,
  ListUnfinishedLargeFilesResponse,
  PartInfo,
  StartLargeFileRequest,
  StartLargeFileResponse,
  UnfinishedLargeFile,
  UploadFileHeaders,
  UploadPartHeaders,
  UploadPartResponse,
} from './upload.ts'

export type {
  DownloadAuthorizationRequest,
  DownloadAuthorizationResponse,
  DownloadByIdRequest,
  DownloadByNameRequest,
  DownloadHeaders,
} from './download.ts'

export type {
  EncryptionAlgorithm,
  EncryptionMode,
  EncryptionSetting,
  NoEncryption,
  SseB2Setting,
  SseCCustomerSetting,
} from './encryption.ts'
export { SSE_B2, SSE_NONE, sseCustomer } from './encryption.ts'

export type {
  FileRetentionValue,
  LegalHoldValue,
  RetentionMode,
  UpdateFileLegalHoldRequest,
  UpdateFileLegalHoldResponse,
  UpdateFileRetentionRequest,
  UpdateFileRetentionResponse,
} from './lock.ts'

export type {
  ApplicationKey,
  CreateKeyRequest,
  DeleteKeyRequest,
  FullApplicationKey,
  ListKeysRequest,
  ListKeysResponse,
} from './key.ts'

export type {
  ReplicationConfiguration,
  ReplicationDestination,
  ReplicationRule,
  ReplicationSource,
} from './replication.ts'

export type {
  EventNotificationRule,
  EventType,
  GetBucketNotificationRulesRequest,
  GetBucketNotificationRulesResponse,
  SetBucketNotificationRulesRequest,
  SetBucketNotificationRulesResponse,
} from './notifications.ts'

export type { B2ErrorCode, B2ErrorResponse } from './errors.ts'
