/**
 * Framework-agnostic B2 storage adapter.
 *
 * This is the unit a plugin author needs: a tiny class with `put`, `get`,
 * `delete`, `signedUrl`, and `list` that maps onto whatever method names the
 * host framework expects (NestJS, Strapi, Payload, AdminJS, Directus, etc.).
 *
 * The adapter is composed, not subclassed. The host's plugin file imports
 * this class, wraps it in whatever lifecycle hook the host wants, and forwards
 * config from the host's config schema.
 */

import { B2Client } from '@backblaze/b2-sdk'
import type { Bucket } from '@backblaze/b2-sdk'
import { BufferSource } from '@backblaze/b2-sdk/streams'

/** Required configuration for {@link B2Storage}. */
export interface B2StorageConfig {
  /** B2 application key ID. From the Backblaze account dashboard. */
  readonly applicationKeyId: string
  /** B2 application key. */
  readonly applicationKey: string
  /** Bucket name (NOT bucket ID). */
  readonly bucket: string
  /**
   * Optional prefix prepended to every key. Useful when one bucket is shared
   * across environments (e.g. `prod/`, `staging/`, or per-tenant prefixes).
   * Trailing slashes are normalised away: pass `users/` or `users`.
   */
  readonly prefix?: string
}

/** Options accepted by {@link B2Storage.signedUrl}. */
export interface SignedUrlOptions {
  /** TTL of the signed URL, in seconds. Default `300` (5 minutes). */
  readonly ttlSeconds?: number
}

/**
 * Minimal storage adapter. Five methods, framework-agnostic, no inheritance.
 *
 * Construct via {@link createStorage}, then call {@link warmup} from your
 * host's lifecycle hook so the first request doesn't pay the auth round-trip.
 */
export class B2Storage {
  private readonly client: B2Client
  private readonly bucketName: string
  private readonly prefix: string
  private bucket: Bucket | null = null

  constructor(config: B2StorageConfig) {
    this.client = new B2Client({
      applicationKeyId: config.applicationKeyId,
      applicationKey: config.applicationKey,
    })
    this.bucketName = config.bucket
    this.prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '')
  }

  /**
   * Call this once during your host's startup hook (NestJS `onModuleInit`,
   * Strapi `bootstrap`, etc.) so the first user request doesn't pay the
   * `b2_authorize_account` round-trip.
   */
  async warmup(): Promise<void> {
    if (this.bucket !== null) return
    await this.client.authorize()
    const bucket = await this.client.getBucket(this.bucketName)
    if (!bucket) throw new Error(`bucket "${this.bucketName}" not found`)
    this.bucket = bucket
  }

  /** Returns the resolved bucket facade, lazily authorising the first call. */
  private async getBucket(): Promise<Bucket> {
    if (this.bucket === null) await this.warmup()
    if (this.bucket === null) throw new Error('bucket not initialised')
    return this.bucket
  }

  /** Apply the configured prefix to a host-facing key. */
  private resolveKey(key: string): string {
    if (!this.prefix) return key
    return `${this.prefix}/${key.replace(/^\/+/, '')}`
  }

  /**
   * Upload bytes under `key`. Returns the B2 file ID. The adapter auto-promotes
   * to multipart for files larger than the recommended part size (~200 MB by
   * default).
   *
   * @param key - Object key, before the configured prefix.
   * @param data - Bytes to upload. Use `Buffer` (Node), `Uint8Array`, or `Blob`.
   * @param contentType - Optional MIME type. Defaults to B2 auto-detect.
   *
   * @returns The file ID issued by B2.
   */
  async put(key: string, data: Uint8Array | Blob, contentType?: string): Promise<string> {
    const bucket = await this.getBucket()
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
    const result = await bucket.upload({
      fileName: this.resolveKey(key),
      source: new BufferSource(bytes),
      ...(contentType !== undefined ? { contentType } : {}),
    })
    return result.fileId
  }

  /**
   * Download `key` as a `ReadableStream<Uint8Array>`. Most host frameworks
   * forward streams directly into their HTTP response, so this avoids
   * buffering the whole file in memory.
   *
   * @param key - Object key, before the configured prefix.
   *
   * @returns The streaming body of the downloaded file.
   */
  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const bucket = await this.getBucket()
    const result = await bucket.download(this.resolveKey(key))
    return result.body
  }

  /**
   * Delete the latest version of `key`. Older versions are not removed;
   * Backblaze keeps them per the bucket's lifecycle rules.
   *
   * @param key - Object key, before the configured prefix.
   */
  async delete(key: string): Promise<void> {
    const bucket = await this.getBucket()
    const resolved = this.resolveKey(key)
    const latest = await bucket.getFileInfoByName(resolved)
    if (!latest) return
    await bucket.deleteFileVersion(resolved, latest.fileId)
  }

  /**
   * Mint a time-limited download URL. The URL works without an auth header,
   * so you can hand it directly to an `<img>` tag or a CDN.
   *
   * Uses B2's native `b2_get_download_authorization`, which produces a token
   * scoped to the file's prefix. The returned URL embeds that token.
   *
   * @param key - Object key, before the configured prefix.
   * @param options - Optional TTL override.
   *
   * @returns A fully-qualified HTTPS URL that expires after `ttlSeconds`.
   */
  async signedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const bucket = await this.getBucket()
    const ttl = options?.ttlSeconds ?? 300
    const resolved = this.resolveKey(key)
    const auth = await bucket.getDownloadAuthorization(resolved, ttl)
    const downloadUrl = this.client.accountInfo.getDownloadUrl()
    return (
      `${downloadUrl}/file/${encodeURIComponent(bucket.name)}/${encodeURIComponent(resolved)}` +
      `?Authorization=${encodeURIComponent(auth.authorizationToken)}`
    )
  }

  /**
   * List keys under a prefix relative to the adapter's configured prefix.
   * Returns up to `limit` results in one call; use the SDK's `listAllFiles`
   * generator directly when you need full pagination.
   *
   * @param prefix - Prefix relative to the adapter's configured prefix.
   * @param limit - Maximum results to return (1-10000). Default `1000`.
   *
   * @returns The list of file names (paths) matching the prefix.
   */
  async list(prefix = '', limit = 1000): Promise<string[]> {
    const bucket = await this.getBucket()
    const resp = await bucket.listFileNames({
      prefix: this.resolveKey(prefix),
      maxFileCount: limit,
    })
    return resp.files.map((f) => f.fileName)
  }
}

/**
 * Construct a {@link B2Storage} adapter. Call {@link B2Storage.warmup} once
 * at startup before serving requests.
 *
 * @param config - Connection + bucket configuration.
 *
 * @returns A new adapter, not yet authorised. Call `warmup()` to authorise.
 */
export function createStorage(config: B2StorageConfig): B2Storage {
  return new B2Storage(config)
}
