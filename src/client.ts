import type { AccountInfo } from './auth/account-info.js'
import { InMemoryAccountInfo } from './auth/in-memory.js'
import { getRealmUrl } from './auth/realms.js'
import { Bucket } from './bucket.js'
import type { RetryOptions } from './http/retry.js'
import type { HttpTransport } from './http/transport.js'
import { FetchTransport, RetryTransport } from './http/transport.js'
import { RawClient } from './raw/index.js'
import type { AuthorizeAccountResponse, Capability } from './types/auth.js'
import type {
  BucketInfo,
  BucketType,
  CorsRule,
  CreateBucketRequest,
  LifecycleRule,
} from './types/bucket.js'
import type { BucketRetentionPolicy } from './types/bucket.js'
import type { EncryptionSetting } from './types/encryption.js'
import type { ApplicationKeyId, BucketId } from './types/ids.js'
import { accountId } from './types/ids.js'
import type { ApplicationKey, FullApplicationKey, ListKeysResponse } from './types/key.js'
import type { ReplicationConfiguration } from './types/replication.js'

export interface B2ClientOptions {
  readonly applicationKeyId: string
  readonly applicationKey: string
  readonly realm?: string
  readonly accountInfo?: AccountInfo
  readonly transport?: HttpTransport
  readonly retry?: Partial<RetryOptions>
  readonly userAgent?: string
}

export class B2Client {
  readonly raw: RawClient
  readonly accountInfo: AccountInfo
  private readonly applicationKeyId: string
  private readonly applicationKey: string
  private readonly realmUrl: string

  constructor(options: B2ClientOptions) {
    this.applicationKeyId = options.applicationKeyId
    this.applicationKey = options.applicationKey
    this.realmUrl = getRealmUrl(options.realm ?? 'production')
    this.accountInfo = options.accountInfo ?? new InMemoryAccountInfo()

    const baseTransport =
      options.transport ??
      new FetchTransport(
        options.userAgent !== undefined ? { userAgent: options.userAgent } : undefined,
      )

    const retryTransport = new RetryTransport({
      transport: baseTransport,
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
      onReauth: () => this.reauthorize(),
    })

    this.raw = new RawClient({ transport: retryTransport })
  }

  async authorize(): Promise<AuthorizeAccountResponse> {
    const auth = await this.raw.authorizeAccount(
      this.applicationKeyId,
      this.applicationKey,
      this.realmUrl,
    )
    this.accountInfo.setAuth(auth)
    return auth
  }

  private async reauthorize(): Promise<void> {
    this.accountInfo.clear()
    await this.authorize()
  }

  // --- Buckets ---

  async createBucket(options: {
    bucketName: string
    bucketType: BucketType
    bucketInfo?: Record<string, string>
    corsRules?: CorsRule[]
    defaultServerSideEncryption?: EncryptionSetting
    defaultRetention?: BucketRetentionPolicy
    fileLockEnabled?: boolean
    lifecycleRules?: LifecycleRule[]
    replicationConfiguration?: ReplicationConfiguration
  }): Promise<Bucket> {
    const request: CreateBucketRequest = {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...options,
    }
    const info = await this.raw.createBucket(
      this.accountInfo.getApiUrl(),
      this.accountInfo.getAuthToken(),
      request,
    )
    return new Bucket(this, info)
  }

  async listBuckets(options?: {
    bucketId?: BucketId
    bucketName?: string
    bucketTypes?: BucketType[]
  }): Promise<Bucket[]> {
    const resp = await this.raw.listBuckets(
      this.accountInfo.getApiUrl(),
      this.accountInfo.getAuthToken(),
      {
        accountId: accountId(this.accountInfo.getAccountId()),
        ...options,
      },
    )
    return resp.buckets.map((info) => new Bucket(this, info))
  }

  async getBucket(bucketName: string): Promise<Bucket | null> {
    const buckets = await this.listBuckets({ bucketName })
    return buckets[0] ?? null
  }

  async deleteBucket(id: BucketId): Promise<BucketInfo> {
    return this.raw.deleteBucket(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      bucketId: id,
    })
  }

  // --- Keys ---

  async createKey(options: {
    capabilities: Capability[]
    keyName: string
    validDurationInSeconds?: number
    bucketId?: BucketId
    namePrefix?: string
  }): Promise<FullApplicationKey> {
    return this.raw.createKey(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...options,
    })
  }

  async listKeys(options?: {
    maxKeyCount?: number
    startApplicationKeyId?: ApplicationKeyId
  }): Promise<ListKeysResponse> {
    return this.raw.listKeys(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...options,
    })
  }

  async deleteKey(applicationKeyId: ApplicationKeyId): Promise<ApplicationKey> {
    return this.raw.deleteKey(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      applicationKeyId,
    })
  }
}
