import type { Capability } from './auth.js'
import type { AccountId, ApplicationKeyId, BucketId } from './ids.js'

export interface CreateKeyRequest {
  readonly accountId: AccountId
  readonly capabilities: readonly Capability[]
  readonly keyName: string
  readonly validDurationInSeconds?: number
  readonly bucketId?: BucketId
  readonly namePrefix?: string
}

export interface FullApplicationKey {
  readonly keyName: string
  readonly applicationKeyId: ApplicationKeyId
  readonly applicationKey: string
  readonly capabilities: readonly Capability[]
  readonly accountId: AccountId
  readonly expirationTimestamp: number | null
  readonly bucketId: BucketId | null
  readonly namePrefix: string | null
  readonly options: readonly string[]
}

export interface ApplicationKey {
  readonly keyName: string
  readonly applicationKeyId: ApplicationKeyId
  readonly capabilities: readonly Capability[]
  readonly accountId: AccountId
  readonly expirationTimestamp: number | null
  readonly bucketId: BucketId | null
  readonly namePrefix: string | null
  readonly options: readonly string[]
}

export interface ListKeysRequest {
  readonly accountId: AccountId
  readonly maxKeyCount?: number
  readonly startApplicationKeyId?: ApplicationKeyId
}

export interface ListKeysResponse {
  readonly keys: readonly ApplicationKey[]
  readonly nextApplicationKeyId: ApplicationKeyId | null
}

export interface DeleteKeyRequest {
  readonly applicationKeyId: ApplicationKeyId
}
