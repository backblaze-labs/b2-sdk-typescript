import { sanitizeErrorReason } from '../../util/error-reason.ts'
import {
  directoryMayContainSyncPaths,
  pathPassesSyncFilters,
  pathSkippedByRegExpInputLimit,
} from '../filters.ts'
import { compareSyncRelativePaths } from '../path-order.ts'
import { validateSyncFilters } from '../regexp-safety.ts'
import { emitScannerSkip, regexpInputTooLongSkip } from '../scan-events.ts'
import { assertScanEntryLimit, scanEntryLimit } from '../scan-limit.ts'
import { isSyncDownloadTempName } from '../temp-files.ts'
import type { LocalSyncPath, SyncErrorEvent, SyncFolder, SyncScanOptions } from '../types.ts'

type LocalDirent = {
  readonly name: string
  isDirectory(): boolean
  isFile(): boolean
}

type LocalStats = {
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
  isFile(): boolean
}

type LocalNodeDeps = {
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<LocalDirent[]>
  lstat(path: string): Promise<LocalStats>
  rm(path: string, options: { readonly force: true }): Promise<void>
  join(...paths: string[]): string
  relative(from: string, to: string): string
  sep: string
}

/**
 * Scans a local directory tree and yields {@link LocalSyncPath} entries sorted by relative path.
 * A root directory read failure aborts the scan with an error diagnostic. Per-entry file or
 * directory failures are reported through `onError` and the scan continues over readable siblings.
 * The current implementation collects matching entries before sorting, so memory usage is
 * proportional to the number of matched files.
 */
export class LocalFolder implements SyncFolder {
  readonly type = 'local' as const
  readonly appliesScanFilters = true as const
  readonly appliesScanSorting = true as const
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
    const nodeDeps = await loadLocalNodeDeps()
    const collected: LocalSyncPath[] = []
    await this.walk(this.root, collected, options, scanEntryLimit(options), nodeDeps)
    collected.sort((a, b) => compareSyncRelativePaths(a.relativePath, b.relativePath))
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
   * @param maxScanEntries - Maximum number of entries to retain before failing.
   * @param nodeDeps - Lazily loaded Node filesystem and path helpers.
   */
  private async walk(
    dir: string,
    out: LocalSyncPath[],
    options: SyncScanOptions,
    maxScanEntries: number,
    nodeDeps: LocalNodeDeps,
  ): Promise<void> {
    if (options.signal?.aborted) return

    let entries: LocalDirent[]
    try {
      entries = await nodeDeps.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const error = this.emitScanError(
        options,
        relativePathFromRoot(this.root, dir, nodeDeps),
        'directory',
        err,
      )
      if (dir === this.root) throw error
      return
    }

    for (const entry of entries) {
      if (options.signal?.aborted) return

      const fullPath = nodeDeps.join(dir, entry.name)
      const rel = relativePathFromRoot(this.root, fullPath, nodeDeps)
      if (rel.includes('\\')) {
        emitScannerSkip(options, {
          type: 'skip',
          path: rel,
          size: 0,
          reason: 'unsafe-name',
          message: `Skipped local path ${JSON.stringify(rel)}: backslashes are not safe sync path characters`,
        })
        continue
      }
      if (entry.isFile() && isSyncDownloadTempName(entry.name)) {
        await nodeDeps.rm(fullPath, { force: true }).catch(() => undefined)
        continue
      }
      // Symlinks, FIFOs, sockets, and device nodes are not syncable files.
      // Ignore them without poisoning delete-mode orphan handling for unrelated paths.
      if (entry.isDirectory()) {
        if (directoryMayContainSyncPaths(rel, options)) {
          await this.walk(fullPath, out, options, maxScanEntries, nodeDeps)
        }
      } else if (entry.isFile()) {
        if (!pathPassesSyncFilters(rel, options)) {
          if (pathSkippedByRegExpInputLimit(rel, options)) {
            emitScannerSkip(options, regexpInputTooLongSkip(rel))
          }
          continue
        }
        try {
          const s = await nodeDeps.lstat(fullPath)
          /* v8 ignore start -- lstat race after a Dirent file result is not deterministic */
          if (!s.isFile()) {
            this.emitScanError(options, rel, 'file', new Error('not a regular file'))
            continue
          }
          /* v8 ignore stop */
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
          assertScanEntryLimit(out.length, maxScanEntries)
        } catch (err) {
          /* v8 ignore next -- stat TOCTOU failures are not deterministic to trigger */
          this.emitScanError(
            options,
            relativePathFromRoot(this.root, fullPath, nodeDeps),
            'file',
            err,
          )
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

async function loadLocalNodeDeps(): Promise<LocalNodeDeps> {
  const [fsPromises, path] = await Promise.all([import('node:fs/promises'), import('node:path')])
  return {
    readdir: fsPromises.readdir as LocalNodeDeps['readdir'],
    lstat: fsPromises.lstat as LocalNodeDeps['lstat'],
    rm: fsPromises.rm as LocalNodeDeps['rm'],
    join: path.join,
    relative: path.relative,
    sep: path.sep,
  }
}

function relativePathFromRoot(root: string, path: string, nodeDeps: LocalNodeDeps): string {
  return nodeDeps.relative(root, path).split(nodeDeps.sep).join('/')
}
