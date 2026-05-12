import type { AccountId, AuthToken, BucketId } from './ids.js'

export type Capability =
  | 'listKeys'
  | 'writeKeys'
  | 'deleteKeys'
  | 'listBuckets'
  | 'listAllBucketNames'
  | 'readBuckets'
  | 'writeBuckets'
  | 'deleteBuckets'
  | 'readBucketRetentions'
  | 'writeBucketRetentions'
  | 'readBucketEncryption'
  | 'writeBucketEncryption'
  | 'readBucketReplications'
  | 'writeBucketReplications'
  | 'readBucketNotifications'
  | 'writeBucketNotifications'
  | 'listFiles'
  | 'readFiles'
  | 'shareFiles'
  | 'writeFiles'
  | 'deleteFiles'
  | 'readFileLegalHolds'
  | 'writeFileLegalHolds'
  | 'readFileRetentions'
  | 'writeFileRetentions'
  | 'bypassGovernance'

export interface AllowedInfo {
  readonly capabilities: readonly Capability[]
  readonly bucketId: BucketId | null
  readonly bucketName: string | null
  readonly namePrefix: string | null
}

export interface StorageApiInfo {
  readonly absoluteMinimumPartSize: number
  readonly apiUrl: string
  readonly bucketId: BucketId | null
  readonly bucketName: string | null
  readonly downloadUrl: string
  readonly infoType: 'storageApi'
  readonly namePrefix: string | null
  readonly recommendedPartSize: number
  readonly s3ApiUrl: string
  readonly allowed: AllowedInfo
}

export interface GroupsApiInfo {
  readonly groupsApiUrl: string
  readonly infoType: 'groupsApi'
}

export interface ApiInfo {
  readonly storageApi: StorageApiInfo
  readonly groupsApi?: GroupsApiInfo
}

export interface AuthorizeAccountResponse {
  readonly accountId: AccountId
  readonly authorizationToken: AuthToken
  readonly apiInfo: ApiInfo
  readonly applicationKeyExpirationTimestamp: number | null
}

export interface AuthorizeAccountRequest {
  readonly applicationKeyId: string
  readonly applicationKey: string
  readonly realm?: string
}
