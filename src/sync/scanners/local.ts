import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LocalSyncPath, SyncErrorEvent, SyncFolder, SyncScanOptions } from '../types.ts'

/**
 * Scans a local directory tree and yields {@link LocalSyncPath} entries
 * sorted by relative path. Unreadable files and directories abort the scan with
 * an error diagnostic so they cannot be mistaken for absent source files.
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

  /**
   * Recursively walks the directory and yields files sorted by relative path.
   * @param options - Optional scan controls.
   */
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<LocalSyncPath> {
    const collected: LocalSyncPath[] = []
    await this.walk(this.root, collected, options)
    collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    for (const entry of collected) {
      if (options.signal?.aborted) return
      yield entry
    }
  }

  /**
   * Recursively collects files from {@link dir} into {@link out}.
   * @param dir - Absolute path of the directory to scan.
   * @param out - Accumulator array that receives discovered file entries.
   * @param options - Optional scan controls.
   */
  private async walk(dir: string, out: LocalSyncPath[], options: SyncScanOptions): Promise<void> {
    if (options.signal?.aborted) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      throw this.emitScanError(options, relativePath(this.root, dir), 'directory', err)
    }

    for (const entry of entries) {
      if (options.signal?.aborted) return

      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walk(fullPath, out, options)
      } else if (entry.isFile()) {
        try {
          const s = await stat(fullPath)
          const rel = relativePath(this.root, fullPath)
          out.push({
            relativePath: rel,
            absolutePath: fullPath,
            modTimeMillis: Math.floor(s.mtimeMs),
            size: s.size,
          })
        } catch (err) {
          /* v8 ignore next -- stat TOCTOU failures are not deterministic to trigger */
          throw this.emitScanError(options, relativePath(this.root, fullPath), 'file', err)
        }
      }
    }
  }

  private emitScanError(
    options: SyncScanOptions,
    path: string,
    kind: 'directory' | 'file',
    err: unknown,
  ): Error {
    const event: SyncErrorEvent = {
      type: 'error',
      path,
      size: 0,
      message: `failed to scan local ${kind}: ${formatScanError(err)}`,
    }
    options.onError?.(event)
    return new Error(event.message)
  }
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function formatScanError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { readonly code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
    /* v8 ignore start -- fallback formatting is for nonstandard filesystem errors */
    const message = err.message.trim()
    if (message.length > 0 && !/[\\/]/.test(message)) return message
    if (err.name.length > 0) return err.name
    /* v8 ignore stop */
  }
  /* v8 ignore next -- defensive fallback for non-Error throws from filesystem shims */
  return 'Error'
}
