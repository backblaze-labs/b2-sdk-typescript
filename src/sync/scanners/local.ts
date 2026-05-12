import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LocalSyncPath, SyncFolder } from '../types.ts'

/**
 * Scans a local directory tree and yields {@link LocalSyncPath} entries
 * sorted by relative path. Unreadable files and directories are silently skipped.
 */
export class LocalFolder implements SyncFolder {
  readonly type = 'local' as const
  /** Absolute path to the local root directory. */
  readonly root: string

  /**
   * Creates a new LocalFolder for the given root directory.
   * @param root - Absolute path to the local directory to scan.
   */
  constructor(root: string) {
    this.root = root
  }

  /** Recursively walks the directory and yields files sorted by relative path. */
  async *scan(): AsyncGenerator<LocalSyncPath> {
    const collected: LocalSyncPath[] = []
    await this.walk(this.root, collected)
    collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    for (const entry of collected) {
      yield entry
    }
  }

  /**
   * Recursively collects files from {@link dir} into {@link out}.
   * @param dir - Absolute path of the directory to scan.
   * @param out - Accumulator array that receives discovered file entries.
   */
  private async walk(dir: string, out: LocalSyncPath[]): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walk(fullPath, out)
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath)
          const rel = relative(this.root, fullPath).split(sep).join('/')
          out.push({
            relativePath: rel,
            absolutePath: fullPath,
            modTimeMillis: Math.floor(s.mtimeMs),
            size: s.size,
          })
        } catch {
          // skip unreadable files
        }
      }
    }
  }
}
