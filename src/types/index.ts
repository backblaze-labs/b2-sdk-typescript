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
  GroupsApiInfo,
  StorageApiInfo,
} from './auth.ts'
// `Capability` is forwarded here as both type and value because the source
// module declares them together via the const-object enum pattern.
export { Capability } from './auth.ts'

export type {
  BucketInfo,
  BucketRetentionPolicy,
  RetentionPeriod,
  CorsRule,
  CreateBucketRequest,
  DeleteBucketRequest,
  LifecycleRule,
  ListBucketsRequest,
  ListBucketsResponse,
  UpdateBucketRequest,
} from './bucket.ts'
// `BucketType`, `BucketRetentionMode`, and `CorsOperation` are forwarded as
// both type and value.
export { BucketRetentionMode, BucketType, CorsOperation } from './bucket.ts'

export type {
  CopyFileRequest,
  CopyPartRequest,
  CopyPartResponse,
  DeleteFileVersionRequest,
  DeleteFileVersionResponse,
  FileVersion,
  GetFileInfoRequest,
  HideFileRequest,
  ListFileNamesRequest,
  ListFileNamesResponse,
  ListFileVersionsRequest,
  ListFileVersionsResponse,
} from './file.ts'
// `FileAction` and `MetadataDirective` are forwarded as both type and value.
export { FileAction, MetadataDirective } from './file.ts'

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
  EncryptionSetting,
  NoEncryption,
  SseB2Setting,
  SseCCustomerSetting,
} from './encryption.ts'
// `EncryptionAlgorithm` and `EncryptionMode` are forwarded as both type and value.
export {
  EncryptionAlgorithm,
  EncryptionMode,
  SSE_B2,
  SSE_NONE,
  sseCustomer,
} from './encryption.ts'

export type {
  FileRetentionValue,
  UpdateFileLegalHoldRequest,
  UpdateFileLegalHoldResponse,
  UpdateFileRetentionRequest,
  UpdateFileRetentionResponse,
} from './lock.ts'
// `LegalHoldValue` and `RetentionMode` are forwarded as both type and value.
export { LegalHoldValue, RetentionMode } from './lock.ts'

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
  GetBucketNotificationRulesRequest,
  GetBucketNotificationRulesResponse,
  SetBucketNotificationRulesRequest,
  SetBucketNotificationRulesResponse,
} from './notifications.ts'
// `EventType` is forwarded as both type and value.
export { EventType } from './notifications.ts'

export type { B2ErrorCode, B2ErrorResponse } from './errors.ts'
