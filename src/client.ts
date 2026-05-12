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

/** Configuration options for creating a {@link B2Client}. */
export interface B2ClientOptions {
  /** The application key ID from the B2 dashboard or `b2_create_key`. */
  readonly applicationKeyId: string
  /** The application key secret. */
  readonly applicationKey: string
  /** B2 realm to authenticate against. Defaults to `"production"`. */
  readonly realm?: string
  /** Storage backend for authorization state. Defaults to {@link InMemoryAccountInfo}. */
  readonly accountInfo?: AccountInfo
  /** Custom HTTP transport. Defaults to {@link FetchTransport}. Wrapped by {@link RetryTransport}. */
  readonly transport?: HttpTransport
  /** Override retry behavior (max retries, backoff, jitter). */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
}

/**
 * High-level B2 client providing ergonomic access to buckets, files, and keys.
 *
 * @example
 * ```ts
 * const client = new B2Client({
 *   applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
 *   applicationKey: process.env.B2_APPLICATION_KEY,
 * })
 * await client.authorize()
 * const buckets = await client.listBuckets()
 * ```
 */
export class B2Client {
  /** Low-level client for direct B2 API calls. */
  readonly raw: RawClient
  /** Authorization state storage (tokens, URLs, capabilities). */
  readonly accountInfo: AccountInfo
  private readonly applicationKeyId: string
  private readonly applicationKey: string
  private readonly realmUrl: string

  /** Creates a new B2Client. Call {@link authorize} before making API requests. */
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

  /** Authenticates with B2 and stores the authorization state. Must be called before other methods. */
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

  /**
   * Creates a new B2 bucket.
   * @param options - Bucket configuration including name, type, and optional settings.
   *
   * @returns A {@link Bucket} handle for the newly created bucket.
   */
  async createBucket(options: {
    /** Globally unique bucket name (6-50 chars, letters, digits, hyphens). */
    bucketName: string
    /** Access level: `"allPrivate"` or `"allPublic"`. */
    bucketType: BucketType
    /** Custom key-value metadata stored with the bucket. */
    bucketInfo?: Record<string, string>
    /** CORS rules for browser-based access. */
    corsRules?: CorsRule[]
    /** Default server-side encryption for new files. */
    defaultServerSideEncryption?: EncryptionSetting
    /** Default retention policy for new files (requires file lock). */
    defaultRetention?: BucketRetentionPolicy
    /** Enable file lock (Object Lock) on the bucket. Cannot be disabled once set. */
    fileLockEnabled?: boolean
    /** Lifecycle rules for automatic file deletion or hiding. */
    lifecycleRules?: LifecycleRule[]
    /** Cross-region replication configuration. */
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

  /**
   * Lists buckets in the account, optionally filtered by ID, name, or type.
   * @returns An array of {@link Bucket} handles.
   */
  async listBuckets(options?: {
    /** Filter to a specific bucket by ID. */
    bucketId?: BucketId
    /** Filter to a specific bucket by name. */
    bucketName?: string
    /** Filter by bucket types (e.g., `["allPrivate"]`). */
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

  /**
   * Looks up a single bucket by name.
   * @returns The {@link Bucket} handle, or `null` if not found.
   */
  async getBucket(bucketName: string): Promise<Bucket | null> {
    const buckets = await this.listBuckets({ bucketName })
    return buckets[0] ?? null
  }

  /** Permanently deletes a bucket. The bucket must be empty. */
  async deleteBucket(id: BucketId): Promise<BucketInfo> {
    return this.raw.deleteBucket(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      bucketId: id,
    })
  }

  /**
   * Creates a new application key with the specified capabilities.
   * @returns The full key including the secret (only returned at creation time).
   */
  async createKey(options: {
    /** Capabilities to grant (e.g., `["readFiles", "writeFiles"]`). */
    capabilities: Capability[]
    /** Human-readable name for the key. */
    keyName: string
    /** Key expiration in seconds from now. Omit for non-expiring keys. */
    validDurationInSeconds?: number
    /** Restrict the key to a single bucket. */
    bucketId?: BucketId
    /** Restrict the key to files with this name prefix. */
    namePrefix?: string
  }): Promise<FullApplicationKey> {
    return this.raw.createKey(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...options,
    })
  }

  /** Lists application keys in the account. */
  async listKeys(options?: {
    /** Maximum number of keys to return per request. */
    maxKeyCount?: number
    /** Start listing after this key ID (for pagination). */
    startApplicationKeyId?: ApplicationKeyId
  }): Promise<ListKeysResponse> {
    return this.raw.listKeys(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...options,
    })
  }

  /** Permanently deletes an application key. */
  async deleteKey(applicationKeyId: ApplicationKeyId): Promise<ApplicationKey> {
    return this.raw.deleteKey(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      applicationKeyId,
    })
  }
}
