import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LocalSyncPath, SyncFolder, SyncPath } from '../types.js'

export class LocalFolder implements SyncFolder {
  readonly type = 'local' as const
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async *scan(): AsyncGenerator<LocalSyncPath> {
    const collected: LocalSyncPath[] = []
    await this.walk(this.root, collected)
    collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    for (const entry of collected) {
      yield entry
    }
  }

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
