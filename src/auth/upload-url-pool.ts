import type { UploadUrlEntry } from './account-info.js'

export class UploadUrlPool {
  private readonly pools = new Map<string, UploadUrlEntry[]>()

  checkout(key: string): UploadUrlEntry | null {
    const pool = this.pools.get(key)
    if (!pool || pool.length === 0) return null
    return pool.pop() ?? null
  }

  checkin(key: string, entry: UploadUrlEntry): void {
    let pool = this.pools.get(key)
    if (!pool) {
      pool = []
      this.pools.set(key, pool)
    }
    pool.push(entry)
  }

  evict(key: string, entry: UploadUrlEntry): void {
    const pool = this.pools.get(key)
    if (!pool) return
    const idx = pool.findIndex((e) => e.uploadUrl === entry.uploadUrl)
    if (idx !== -1) {
      pool.splice(idx, 1)
    }
  }

  clear(): void {
    this.pools.clear()
  }
}
