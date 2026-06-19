import { lstat, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { sanitizeErrorReason } from '../../util/error-reason.ts'
import { directoryMayContainSyncPaths, pathPassesSyncFilters } from '../filters.ts'
import { compareSyncPathNames } from '../path-order.ts'
import { validateSyncFilters } from '../regexp-safety.ts'
import type { LocalSyncPath, SyncErrorEvent, SyncFolder, SyncScanOptions } from '../types.ts'

/**
 * Scans a local directory tree and yields {@link LocalSyncPath} entries
 * sorted by deterministic relative path order. A root directory read failure aborts the scan with
 * an error diagnostic. Per-entry file or directory failures are reported through `onError` and the
 * scan continues over readable siblings so partial results can still be synchronized.
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
   * Recursively walks the directory and yields files in sync path order.
   * @param options - Optional scan controls.
   */
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<LocalSyncPath> {
    validateSyncFilters(options)
    const collected: LocalSyncPath[] = []
    await this.walk(this.root, collected, options)
    collected.sort((a, b) => compareSyncPathNames(a.relativePath, b.relativePath))
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
      const error = this.emitScanError(options, relativePath(this.root, dir), 'directory', err)
      if (dir === this.root) throw error
      return
    }

    for (const entry of entries) {
      if (options.signal?.aborted) return

      const fullPath = join(dir, entry.name)
      const rel = relativePath(this.root, fullPath)
      // Symlinks, FIFOs, sockets, and device nodes are not syncable files.
      // Ignore them without poisoning delete-mode orphan handling for unrelated paths.
      if (entry.isDirectory()) {
        if (directoryMayContainSyncPaths(rel, options)) {
          await this.walk(fullPath, out, options)
        }
      } else if (entry.isFile()) {
        try {
          const s = await lstat(fullPath)
          /* v8 ignore start -- lstat race after a Dirent file result is not deterministic */
          if (!s.isFile()) {
            this.emitScanError(options, rel, 'file', new Error('not a regular file'))
            continue
          }
          /* v8 ignore stop */
          if (!pathPassesSyncFilters(rel, options)) continue
          out.push({
            relativePath: rel,
            absolutePath: fullPath,
            modTimeMillis: Math.floor(s.mtimeMs),
            size: s.size,
            fileIdentity: {
              deviceId: s.dev,
              inode: s.ino,
              size: s.size,
              modTimeMillis: Math.floor(s.mtimeMs),
            },
          })
        } catch (err) {
          /* v8 ignore next -- stat TOCTOU failures are not deterministic to trigger */
          this.emitScanError(options, relativePath(this.root, fullPath), 'file', err)
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
      message: `failed to scan local ${kind}: ${sanitizeErrorReason(err)}`,
    }
    options.onError?.(event)
    return new Error(event.message)
  }
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}
