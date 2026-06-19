import type { AccountInfo } from './auth/account-info.ts'
import { InMemoryAccountInfo } from './auth/in-memory.ts'
import { getRealmUrl } from './auth/realms.ts'
import { Bucket } from './bucket.ts'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from './http/retry.ts'
import type { HttpTransport } from './http/transport.ts'
import { FetchTransport, RetryTransport } from './http/transport.ts'
import { deriveAllowedSuffixes, UrlGuard } from './http/url-guard.ts'
import { setClientUploadRetryOptions } from './internal/upload-retry-options.ts'
import { RawClient } from './raw/index.ts'
import type { AuthorizeAccountResponse, Capability } from './types/auth.ts'
import type {
  BucketInfo,
  BucketRetentionPolicy,
  BucketType,
  CorsRule,
  CreateBucketRequest,
  LifecycleRule,
} from './types/bucket.ts'
import type { EncryptionSetting } from './types/encryption.ts'
import type { ApplicationKeyId, BucketId } from './types/ids.ts'
import { accountId } from './types/ids.ts'
import type { ApplicationKey, FullApplicationKey, ListKeysResponse } from './types/key.ts'
import type { ReplicationConfiguration } from './types/replication.ts'
import { DEFAULT_PAGE_SIZE } from './util/defaults.ts'
import { type PaginatorOptions, paginateItems } from './util/paginator.ts'

/** Result of {@link B2Client.hasCapabilities}. */
export interface CapabilityCheckResult {
  /** `true` when the key carries every requested capability. */
  readonly ok: boolean
  /** Capabilities the call requested that the current key does not hold. Empty when `ok` is `true`. */
  readonly missing: readonly Capability[]
}

/** Configuration options for creating a {@link B2Client}. */
export interface B2ClientOptions {
  /** The application key ID from the B2 dashboard or `b2_create_key`. */
  readonly applicationKeyId: string
  /** The application key secret. */
  readonly applicationKey: string
  /**
   * B2 realm to authenticate against. Accepts a known realm-map key or a direct
   * base URL. Plain HTTP URLs are rejected unless they target a loopback host.
   * Defaults to `"production"`.
   */
  readonly realm?: string
  /** Storage backend for authorization state. Defaults to {@link InMemoryAccountInfo}. */
  readonly accountInfo?: AccountInfo
  /** Custom HTTP transport. Defaults to {@link FetchTransport}. Wrapped by {@link RetryTransport}. */
  readonly transport?: HttpTransport
  /** Override retry behavior (max retries, backoff, jitter). */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
  /**
   * Override the SSRF allow-list. By default the SDK locks the
   * {@link FetchTransport} to host suffixes derived from the realm's authorize
   * response (e.g. `backblazeb2.com`, `backblaze.com`) so a compromised B2
   * endpoint cannot redirect the SDK to internal services. Pass an explicit
   * list to add hosts (e.g. when testing against a self-hosted proxy) or set
   * to an empty array to disable the guard entirely (not recommended).
   *
   * Only consulted when {@link B2ClientOptions.transport} is unset; a custom
   * transport is the user's responsibility to harden.
   */
  readonly allowedHostSuffixes?: readonly string[]
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
  /**
   * SSRF allow-list applied by the default {@link FetchTransport}. `null` when
   * a custom transport was supplied — in that case the SDK does not own the
   * guard. Locked down by {@link B2Client.authorize}.
   */
  readonly urlGuard: UrlGuard | null
  private readonly applicationKeyId: string
  private readonly applicationKey: string
  private readonly realmUrl: string
  private readonly userAllowedSuffixes: readonly string[] | undefined

  /**
   * Creates a new B2Client. Call {@link authorize} before making API requests.
   * @param options - Configuration including credentials, realm, and transport settings.
   */
  constructor(options: B2ClientOptions) {
    this.applicationKeyId = options.applicationKeyId
    this.applicationKey = options.applicationKey
    this.realmUrl = getRealmUrl(options.realm ?? 'production')
    this.accountInfo = options.accountInfo ?? new InMemoryAccountInfo()
    this.userAllowedSuffixes = options.allowedHostSuffixes
    const uploadRetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry }
    setClientUploadRetryOptions(this, uploadRetryOptions)

    let baseTransport: HttpTransport
    if (options.transport !== undefined) {
      baseTransport = options.transport
      this.urlGuard = null
    } else {
      const urlGuard = new UrlGuard()
      baseTransport = new FetchTransport({
        urlGuard,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
      })
      this.urlGuard = urlGuard
    }

    const retryTransport = new RetryTransport({
      transport: baseTransport,
      retry: uploadRetryOptions,
      onReauth: () => this.reauthorize(),
    })

    this.raw = new RawClient({ transport: retryTransport })
  }
  /**
   * Authenticates with B2 and stores the authorization state. Must be called before other methods.
   *
   * @returns The authorization response containing tokens, URLs, and capabilities.
   */
  async authorize(): Promise<AuthorizeAccountResponse> {
    const auth = await this.raw.authorizeAccount(
      this.applicationKeyId,
      this.applicationKey,
      this.realmUrl,
    )
    this.accountInfo.setAuth(auth)
    // Lock the SSRF guard to the realm's hosts (plus any user additions).
    // No-op when the caller supplied a custom transport: their threat model.
    if (this.urlGuard !== null) {
      const derived = deriveAllowedSuffixes(auth.apiInfo.storageApi)
      const merged =
        this.userAllowedSuffixes !== undefined
          ? this.userAllowedSuffixes.length === 0
            ? []
            : Array.from(new Set([...derived, ...this.userAllowedSuffixes]))
          : derived
      this.urlGuard.setAllowedSuffixes(merged)
    }
    return auth
  }

  /**
   * Refresh credentials after a 401. Returns the fresh auth token so
   * {@link RetryTransport} can rewrite the in-flight request's
   * Authorization header before retrying.
   *
   * @returns The fresh authorization token.
   */
  private async reauthorize(): Promise<string> {
    this.accountInfo.clear()
    const auth = await this.authorize()
    return auth.authorizationToken
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
   * @param options - Optional filters for bucket ID, name, or type.
   *
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
   * @param bucketName - The name of the bucket to find.
   *
   * @returns The {@link Bucket} handle, or `null` if not found.
   */
  async getBucket(bucketName: string): Promise<Bucket | null> {
    const buckets = await this.listBuckets({ bucketName })
    return buckets[0] ?? null
  }

  /**
   * Permanently deletes a bucket. The bucket must be empty.
   * @param id - The unique identifier of the bucket to delete.
   *
   * @returns The deleted bucket metadata.
   */
  async deleteBucket(id: BucketId): Promise<BucketInfo> {
    return this.raw.deleteBucket(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      bucketId: id,
    })
  }

  /**
   * Creates a new application key with the specified capabilities.
   * @param options - Key configuration including capabilities, name, and optional restrictions.
   *
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

  /**
   * Lists application keys in the account.
   * @param options - Optional pagination settings.
   *
   * @returns A page of application keys with an optional continuation token.
   */
  async listKeys(options?: {
    /**
     * Maximum number of keys to return per request. Forwarded to the
     * raw API's `maxKeyCount` parameter.
     */
    pageSize?: number
    /** Start listing after this key ID (for pagination). */
    startApplicationKeyId?: ApplicationKeyId
  }): Promise<ListKeysResponse> {
    return this.raw.listKeys(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      accountId: accountId(this.accountInfo.getAccountId()),
      ...(options?.pageSize !== undefined ? { maxKeyCount: options.pageSize } : {}),
      ...(options?.startApplicationKeyId !== undefined
        ? { startApplicationKeyId: options.startApplicationKeyId }
        : {}),
    })
  }

  /**
   * Async iterator that yields every application key on the account,
   * automatically handling pagination via `listKeys`.
   *
   * @param options - Pagination + abort options. `pageSize` is forwarded
   *   to `maxKeyCount`; the default is 1000.
   *
   * @returns An async iterable of {@link ApplicationKey} entries.
   *
   * @example
   * ```ts
   * for await (const key of client.paginateKeys()) {
   *   console.log(key.keyName, key.capabilities)
   * }
   * ```
   */
  paginateKeys(options?: PaginatorOptions): AsyncIterableIterator<ApplicationKey> {
    return paginateItems(
      async (cursor: ApplicationKeyId | undefined) => {
        const resp = await this.listKeys({
          pageSize: options?.pageSize ?? DEFAULT_PAGE_SIZE,
          ...(cursor !== undefined ? { startApplicationKeyId: cursor } : {}),
        })
        return { page: resp, nextCursor: resp.nextApplicationKeyId ?? undefined }
      },
      (page) => page.keys,
      options?.signal,
    )
  }

  /**
   * Permanently deletes an application key.
   * @param applicationKeyId - The unique identifier of the key to delete.
   *
   * @returns The deleted application key metadata.
   */
  async deleteKey(applicationKeyId: ApplicationKeyId): Promise<ApplicationKey> {
    return this.raw.deleteKey(this.accountInfo.getApiUrl(), this.accountInfo.getAuthToken(), {
      applicationKeyId,
    })
  }

  /**
   * Checks whether the authorized application key carries every capability in
   * `needed`. Returns the missing capabilities so callers can fail fast with a
   * clear error instead of a generic 401/403 from the server.
   *
   * @param needed - The capabilities required by the planned operation.
   *
   * @returns An object with `ok: true` when every needed capability is
   *   present, otherwise `{ ok: false, missing: [...] }`.
   *
   * @throws If {@link authorize} has not been called yet.
   */
  hasCapabilities(needed: readonly Capability[]): CapabilityCheckResult {
    const auth = this.accountInfo.getAuth()
    if (!auth) throw new Error('Not authorized. Call authorize() first.')
    const available = new Set<string>(auth.apiInfo.storageApi.allowed.capabilities)
    const missing = needed.filter((cap) => !available.has(cap as string))
    return { ok: missing.length === 0, missing }
  }
}
