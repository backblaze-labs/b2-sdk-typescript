declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type AccountId = Brand<string, 'AccountId'>
export type BucketId = Brand<string, 'BucketId'>
export type FileId = Brand<string, 'FileId'>
export type KeyId = Brand<string, 'KeyId'>
export type ApplicationKeyId = Brand<string, 'ApplicationKeyId'>
export type UploadUrl = Brand<string, 'UploadUrl'>
export type UploadAuthToken = Brand<string, 'UploadAuthToken'>
export type AuthToken = Brand<string, 'AuthToken'>
export type LargeFileId = Brand<string, 'LargeFileId'>

export function accountId(raw: string): AccountId {
  return raw as AccountId
}

export function bucketId(raw: string): BucketId {
  return raw as BucketId
}

export function fileId(raw: string): FileId {
  return raw as FileId
}

export function keyId(raw: string): KeyId {
  return raw as KeyId
}

export function applicationKeyId(raw: string): ApplicationKeyId {
  return raw as ApplicationKeyId
}
