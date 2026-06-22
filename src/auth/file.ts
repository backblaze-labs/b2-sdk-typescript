import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AuthorizeAccountResponse } from '../types/auth.ts'
import type { BucketId } from '../types/ids.ts'
import type { AccountInfo, AuthContextAwareAccountInfo, UploadUrlEntry } from './account-info.ts'
import { InMemoryAccountInfo } from './in-memory.ts'
import { REALM_URLS } from './realms.ts'

const PRIVATE_FILE_MODE = 0o600
const PERSISTED_AUTH_VERSION = 1
const PRODUCTION_HOST_SUFFIX = 'backblazeb2.com'
const STAGING_HOST_SUFFIX = 'backblaze.net'

interface PersistedAuthState {
  readonly _b2sdk?: {
    readonly version?: number
    readonly realmUrl?: string
    readonly applicationKeyId?: string
  }
}

/** Reason a loaded auth cache entry was ignored for the current client. */
export type FileAccountInfoDiscardReason =
  | 'realm_mismatch'
  | 'application_key_mismatch'
  | 'endpoint_mismatch'

/** Event emitted when a loaded cache entry is ignored without modifying disk. */
export interface FileAccountInfoDiscardEvent {
  /** Absolute path of the auth cache file. */
  readonly path: string
  /** Why the loaded auth entry could not be reused. */
  readonly reason: FileAccountInfoDiscardReason
  /** Realm URL stored in the cache metadata, or null for legacy entries. */
  readonly cachedRealmUrl: string | null | undefined
  /** Realm URL configured on the current client, if already bound. */
  readonly expectedRealmUrl: string | undefined
  /** Application key ID stored in cache metadata, or null for legacy entries. */
  readonly cachedApplicationKeyId: string | null | undefined
  /** Application key ID configured on the current client, if already bound. */
  readonly expectedApplicationKeyId: string | undefined
}

/** Event emitted when an asynchronous auth-cache write fails. */
export interface FileAccountInfoWriteErrorEvent {
  /** Absolute path of the auth cache file. */
  readonly path: string
  /** Underlying filesystem or serialization error. */
  readonly error: unknown
}

/** Optional observers for file-backed auth cache behavior. */
export interface FileAccountInfoOptions {
  /**
   * Called when loaded auth is ignored because its metadata or cached
   * endpoints are unsafe for this client. The on-disk file is left untouched
   * so another process using a different realm/key is not clobbered.
   */
  readonly onDiscard?: (event: FileAccountInfoDiscardEvent) => void
  /** Called when an asynchronous auth-cache write fails. */
  readonly onWriteError?: (event: FileAccountInfoWriteErrorEvent) => void
}

function readPersistedAuthState(value: unknown): {
  auth: AuthorizeAccountResponse
  realmUrl: string | null
  applicationKeyId: string | null
} | null {
  if (value === null || typeof value !== 'object') return null

  const maybeState = value as PersistedAuthState
  if (
    maybeState._b2sdk?.version !== undefined &&
    maybeState._b2sdk.version !== PERSISTED_AUTH_VERSION
  ) {
    return null
  }
  const realmUrl =
    maybeState._b2sdk !== undefined && typeof maybeState._b2sdk.realmUrl === 'string'
      ? maybeState._b2sdk.realmUrl
      : null
  const applicationKeyId =
    maybeState._b2sdk !== undefined && typeof maybeState._b2sdk.applicationKeyId === 'string'
      ? maybeState._b2sdk.applicationKeyId
      : null
  return { auth: value as AuthorizeAccountResponse, realmUrl, applicationKeyId }
}

function isProductionBackblazeEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && hasHostSuffix(parsed.hostname, PRODUCTION_HOST_SUFFIX)
  } catch {
    return false
  }
}

function isProductionAuthResponse(auth: AuthorizeAccountResponse): boolean {
  try {
    const storageApi = auth.apiInfo.storageApi
    return [storageApi.apiUrl, storageApi.downloadUrl, storageApi.s3ApiUrl].every(
      isProductionBackblazeEndpoint,
    )
  } catch {
    return false
  }
}

function verifiedRealmEndpointSuffix(realmUrl: string): string | null {
  try {
    const host = new URL(realmUrl).hostname.toLowerCase()
    if (hasHostSuffix(host, PRODUCTION_HOST_SUFFIX)) return PRODUCTION_HOST_SUFFIX
    if (hasHostSuffix(host, STAGING_HOST_SUFFIX)) return STAGING_HOST_SUFFIX
  } catch {
    // Fall through below.
  }
  return null
}

function hasHostSuffix(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase()
  const lowered = suffix.toLowerCase()
  return host === lowered || host.endsWith(`.${lowered}`)
}

function isEndpointInRealm(url: string, realmUrl: string): boolean {
  try {
    const realm = new URL(realmUrl)
    const endpoint = new URL(url)
    const endpointHost = endpoint.hostname.toLowerCase()
    const realmHost = realm.hostname.toLowerCase()
    if (isLoopbackEndpointHost(endpointHost) || isLoopbackEndpointHost(realmHost)) {
      return endpoint.origin === realm.origin
    }

    const verifiedSuffix = verifiedRealmEndpointSuffix(realmUrl)
    if (verifiedSuffix !== null) {
      return endpoint.protocol === 'https:' && hasHostSuffix(endpointHost, verifiedSuffix)
    }

    return endpoint.protocol === realm.protocol && hasHostSuffix(endpointHost, realmHost)
  } catch {
    return false
  }
}

function isLoopbackEndpointHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true

  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  )
}

function authEndpointsMatchRealm(auth: AuthorizeAccountResponse, realmUrl: string): boolean {
  try {
    const storageApi = auth.apiInfo.storageApi
    return [storageApi.apiUrl, storageApi.downloadUrl, storageApi.s3ApiUrl].every((url) =>
      isEndpointInRealm(url, realmUrl),
    )
  } catch {
    return false
  }
}

/**
 * Node-only {@link AccountInfo} backend that persists the authorization
 * response to a JSON file. Upload URL pools remain in memory because URLs are
 * short-lived and shouldn't be shared across processes.
 * The JSON file contains a live B2 authorization token, so treat it as
 * sensitive and keep it out of shared or world-readable locations.
 * `FileAccountInfo` serializes writes within one process but does not provide
 * inter-process locking. If multiple processes share one path, use
 * {@link FileAccountInfoOptions.onDiscard} and {@link FileAccountInfoOptions.onWriteError}
 * to observe cache churn, or prefer one cache path per resolved realm and key.
 *
 * On instantiation, call {@link FileAccountInfo.load} to populate state from
 * disk (or start fresh if the file is missing or corrupt). The authorization
 * response is written back to disk on every {@link setAuth} or {@link clear}
 * call so a process restart can resume without re-authorizing.
 * Cache files without an SDK metadata application-key binding are ignored once
 * bound to a `B2Client`, because the SDK cannot verify which key wrote them.
 *
 * This module imports `node:fs/promises`; do not load it in browser bundles.
 */
export class FileAccountInfo implements AccountInfo, AuthContextAwareAccountInfo {
  private readonly inner = new InMemoryAccountInfo()
  private writeQueue: Promise<void> = Promise.resolve()
  private realmUrl: string | undefined
  private loadedAuthRealmUrl: string | null | undefined
  private applicationKeyId: string | undefined
  private loadedAuthApplicationKeyId: string | null | undefined

  /**
   * Constructs a `FileAccountInfo` bound to a JSON file on disk. The file is
   * created on the first `setAuth` write; reading it back happens via
   * {@link load}.
   *
   * @param path - Absolute path to the JSON file that backs this account info.
   * @param options - Optional discard and write-error observers.
   */
  constructor(
    public readonly path: string,
    private readonly options: FileAccountInfoOptions = {},
  ) {}

  /**
   * Reads the JSON file at the configured path and populates in-memory state.
   * If the file is missing or contains invalid JSON, leaves state empty and
   * returns silently (a re-auth is expected next).
   *
   * @returns A promise that resolves when load is complete.
   */
  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8')
      const parsed = readPersistedAuthState(JSON.parse(text) as unknown)
      if (parsed === null) return
      this.inner.setAuth(parsed.auth)
      this.loadedAuthRealmUrl = parsed.realmUrl
      this.loadedAuthApplicationKeyId = parsed.applicationKeyId
      this.discardMismatchedAuth()
    } catch {
      // Missing file, invalid JSON, or permission denied: start empty.
    }
  }

  /**
   * Binds this cache to the configured realm URL. `B2Client` calls this when a
   * FileAccountInfo instance is supplied, so stale auth produced by another
   * realm is discarded before it can be used.
   *
   * @param realmUrl - Resolved authorize-account realm URL for the client.
   */
  setRealmUrl(realmUrl: string): void {
    this.realmUrl = realmUrl
    this.discardMismatchedAuth()
  }

  /**
   * Binds this cache to the configured application key ID. `B2Client` calls
   * this when a FileAccountInfo instance is supplied, so stale auth produced by
   * another key is discarded before it can be used.
   *
   * @param applicationKeyId - Application key ID configured on the client.
   */
  setApplicationKeyId(applicationKeyId: string): void {
    this.applicationKeyId = applicationKeyId
    this.discardMismatchedAuth()
  }

  private discardMismatchedAuth(): void {
    const auth = this.inner.getAuth()
    if (auth === null) return

    const reason = this.mismatchReason(auth)
    if (reason === null) return

    this.inner.clear()
    this.options.onDiscard?.({
      path: this.path,
      reason,
      cachedRealmUrl: this.loadedAuthRealmUrl,
      expectedRealmUrl: this.realmUrl,
      cachedApplicationKeyId: this.loadedAuthApplicationKeyId,
      expectedApplicationKeyId: this.applicationKeyId,
    })
    this.loadedAuthRealmUrl = undefined
    this.loadedAuthApplicationKeyId = undefined
  }

  private mismatchReason(auth: AuthorizeAccountResponse): FileAccountInfoDiscardReason | null {
    const realmMatches =
      this.realmUrl === undefined ||
      this.loadedAuthRealmUrl === this.realmUrl ||
      (this.loadedAuthRealmUrl === null &&
        this.realmUrl === REALM_URLS['production'] &&
        isProductionAuthResponse(auth))
    const applicationKeyMatches =
      this.applicationKeyId === undefined ||
      this.loadedAuthApplicationKeyId === this.applicationKeyId
    if (!realmMatches) return 'realm_mismatch'
    if (!applicationKeyMatches) return 'application_key_mismatch'
    if (this.realmUrl !== undefined && !authEndpointsMatchRealm(auth, this.realmUrl)) {
      return 'endpoint_mismatch'
    }

    return null
  }

  /**
   * Persists the current auth response to the file. Atomically queues writes
   * so concurrent updates serialize.
   *
   * @returns A promise that resolves when the write completes.
   */
  private flush(): Promise<void> {
    const auth = this.inner.getAuth()
    const next = this.writeQueue.then(async () => {
      if (auth === null) {
        try {
          await this.writePrivateFileAtomically('')
        } catch {
          // Best-effort
        }
        return
      }
      const contents =
        this.realmUrl !== undefined
          ? JSON.stringify({
              ...auth,
              _b2sdk: {
                version: PERSISTED_AUTH_VERSION,
                realmUrl: this.realmUrl,
                ...(this.applicationKeyId !== undefined
                  ? { applicationKeyId: this.applicationKeyId }
                  : {}),
              },
            })
          : JSON.stringify(auth)
      await this.writePrivateFileAtomically(contents)
    })
    this.writeQueue = next.catch((error: unknown) => {
      this.options.onWriteError?.({ path: this.path, error })
    })
    return next
  }

  private async writePrivateFileAtomically(contents: string): Promise<void> {
    const dir = dirname(this.path)
    const tempPath = join(dir, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`)
    await mkdir(dir, { recursive: true })

    try {
      await writeFile(tempPath, contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
      await chmod(tempPath, PRIVATE_FILE_MODE)
      await rename(tempPath, this.path)
      await chmod(this.path, PRIVATE_FILE_MODE)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Stores the given authorization response and triggers an async write to disk.
   *
   * @param auth - The authorize-account response to persist.
   */
  setAuth(auth: AuthorizeAccountResponse): void {
    this.inner.setAuth(auth)
    this.loadedAuthRealmUrl = this.realmUrl ?? null
    this.loadedAuthApplicationKeyId = this.applicationKeyId ?? null
    void this.flush()
  }

  /**
   * Returns the currently cached authorization response, or `null` if none.
   *
   * @returns The cached authorization response, or `null` if not authorized.
   */
  getAuth(): AuthorizeAccountResponse | null {
    return this.inner.getAuth()
  }

  /** Discards in-memory state and clears the on-disk file. */
  clear(): void {
    this.inner.clear()
    this.loadedAuthRealmUrl = undefined
    this.loadedAuthApplicationKeyId = undefined
    void this.flush()
  }

  /**
   * Returns the cached B2 API URL.
   *
   * @returns The base URL for B2 API calls.
   */
  getApiUrl(): string {
    return this.inner.getApiUrl()
  }

  /**
   * Returns the cached file-download URL.
   *
   * @returns The base URL for file downloads.
   */
  getDownloadUrl(): string {
    return this.inner.getDownloadUrl()
  }

  /**
   * Returns the cached session authorization token.
   *
   * @returns The current authorization token.
   */
  getAuthToken(): string {
    return this.inner.getAuthToken()
  }

  /**
   * Returns the cached account identifier.
   *
   * @returns The authorized account ID.
   */
  getAccountId(): string {
    return this.inner.getAccountId()
  }

  /**
   * Returns the server-recommended part size for multipart uploads.
   *
   * @returns The recommended part size in bytes.
   */
  getRecommendedPartSize(): number {
    return this.inner.getRecommendedPartSize()
  }

  /**
   * Returns the server-enforced minimum part size for multipart uploads.
   *
   * @returns The absolute minimum part size in bytes.
   */
  getAbsoluteMinimumPartSize(): number {
    return this.inner.getAbsoluteMinimumPartSize()
  }

  /**
   * Returns the cached S3-compatible API URL.
   *
   * @returns The base URL for the S3-compatible API.
   */
  getS3ApiUrl(): string {
    return this.inner.getS3ApiUrl()
  }

  /**
   * Returns the bucket the key is restricted to, if any.
   *
   * @returns The restricted bucket ID, or `null` if the key is unrestricted.
   */
  getAllowedBucketId(): BucketId | null {
    return this.inner.getAllowedBucketId()
  }

  /**
   * Takes an upload URL from the in-memory pool for the given bucket.
   *
   * @param bucketId - Bucket to check out an upload URL for.
   *
   * @returns A reusable upload URL entry, or `null` if none are pooled.
   */
  checkoutUploadUrl(bucketId: BucketId): UploadUrlEntry | null {
    return this.inner.checkoutUploadUrl(bucketId)
  }

  /**
   * Returns a still-valid upload URL to the pool for reuse.
   *
   * @param bucketId - Bucket the upload URL belongs to.
   * @param entry - Upload URL entry to return.
   */
  returnUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.inner.returnUploadUrl(bucketId, entry)
  }

  /**
   * Removes an upload URL from the pool after an upload error.
   *
   * @param bucketId - Bucket the failed upload URL belongs to.
   * @param entry - Upload URL entry to evict.
   */
  evictUploadUrl(bucketId: BucketId, entry: UploadUrlEntry): void {
    this.inner.evictUploadUrl(bucketId, entry)
  }

  /**
   * Takes a large-file part upload URL from the in-memory pool.
   *
   * @param fileId - Large file to check out a part upload URL for.
   *
   * @returns A reusable part upload URL entry, or `null` if none are pooled.
   */
  checkoutPartUploadUrl(fileId: string): UploadUrlEntry | null {
    return this.inner.checkoutPartUploadUrl(fileId)
  }

  /**
   * Returns a still-valid part upload URL to the pool for reuse.
   *
   * @param fileId - Large file the part upload URL belongs to.
   * @param entry - Part upload URL entry to return.
   */
  returnPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.inner.returnPartUploadUrl(fileId, entry)
  }

  /**
   * Removes a part upload URL from the pool after an error.
   *
   * @param fileId - Large file the failed part upload URL belongs to.
   * @param entry - Part upload URL entry to evict.
   */
  evictPartUploadUrl(fileId: string, entry: UploadUrlEntry): void {
    this.inner.evictPartUploadUrl(fileId, entry)
  }

  /**
   * Awaits any pending disk writes. Call before process exit to ensure the
   * latest state is persisted.
   *
   * @returns A promise that resolves once all queued writes are flushed.
   */
  async flushed(): Promise<void> {
    await this.writeQueue
  }
}
