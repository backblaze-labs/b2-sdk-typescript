import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AuthorizeAccountResponse } from '../types/auth.ts'
import type { BucketId } from '../types/ids.ts'
import type { AccountInfo, UploadUrlEntry } from './account-info.ts'
import { InMemoryAccountInfo } from './in-memory.ts'

const PRIVATE_FILE_MODE = 0o600

/**
 * Node-only {@link AccountInfo} backend that persists the authorization
 * response to a JSON file. Upload URL pools remain in memory because URLs are
 * short-lived and shouldn't be shared across processes.
 * The JSON file contains a live B2 authorization token, so treat it as
 * sensitive and keep it out of shared or world-readable locations.
 *
 * On instantiation, call {@link FileAccountInfo.load} to populate state from
 * disk (or start fresh if the file is missing or corrupt). The authorization
 * response is written back to disk on every {@link setAuth} or {@link clear}
 * call so a process restart can resume without re-authorizing.
 *
 * This module imports `node:fs/promises`; do not load it in browser bundles.
 */
export class FileAccountInfo implements AccountInfo {
  private readonly inner = new InMemoryAccountInfo()
  private writeQueue: Promise<void> = Promise.resolve()

  /**
   * Constructs a `FileAccountInfo` bound to a JSON file on disk. The file is
   * created on the first `setAuth` write; reading it back happens via
   * {@link load}.
   *
   * @param path - Absolute path to the JSON file that backs this account info.
   */
  constructor(public readonly path: string) {}

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
      const parsed = JSON.parse(text) as AuthorizeAccountResponse
      this.inner.setAuth(parsed)
    } catch {
      // Missing file, invalid JSON, or permission denied: start empty.
    }
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
      await this.writePrivateFileAtomically(JSON.stringify(auth))
    })
    this.writeQueue = next.catch(() => {})
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
