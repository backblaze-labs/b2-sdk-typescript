import type { UploadUrlEntry } from './account-info.js'

/**
 * Manages a pool of reusable upload URLs keyed by bucket ID or file ID.
 * URLs are checked out before an upload, checked back in on success, and
 * evicted on error so they are not reused.
 */
export class UploadUrlPool {
  /** Map from key (bucket ID or file ID) to a stack of available entries. */
  private readonly pools = new Map<string, UploadUrlEntry[]>()

  /**
   * Take an upload URL from the pool, or return null if none are available.
   *
   * @param key - The bucket ID or file ID to look up.
   *
   * @returns An upload URL entry, or null if the pool is empty for the given key.
   */
  checkout(key: string): UploadUrlEntry | null {
    const pool = this.pools.get(key)
    if (!pool || pool.length === 0) return null
    return pool.pop() ?? null
  }

  /**
   * Return a still-valid upload URL to the pool for future reuse.
   *
   * @param key - The bucket ID or file ID the entry belongs to.
   * @param entry - The upload URL entry to return to the pool.
   */
  checkin(key: string, entry: UploadUrlEntry): void {
    let pool = this.pools.get(key)
    if (!pool) {
      pool = []
      this.pools.set(key, pool)
    }
    pool.push(entry)
  }

  /**
   * Remove a specific upload URL from the pool (e.g. after an upload error).
   *
   * @param key - The bucket ID or file ID the entry belongs to.
   * @param entry - The failed upload URL entry to remove.
   */
  evict(key: string, entry: UploadUrlEntry): void {
    const pool = this.pools.get(key)
    if (!pool) return
    const idx = pool.findIndex((e) => e.uploadUrl === entry.uploadUrl)
    if (idx !== -1) {
      pool.splice(idx, 1)
    }
  }

  /** Remove all entries from every key in the pool. */
  clear(): void {
    this.pools.clear()
  }
}
