import {
  isDownloadStagingDirectorySegment,
  isManagedDownloadStagingRoot,
} from '../download-staging.ts'
import { localFilesystemErrorReason } from '../filesystem-errors.ts'
import {
  directoryMayContainSyncPaths,
  pathPassesSyncFilters,
  pathSkippedByRegExpInputLimit,
} from '../filters.ts'
import { localFileIdentityFromStats } from '../local-file-identity.ts'
import { registerLocalFilesystemRoot } from '../local-filesystem-root.ts'
import { compareSyncRelativePaths } from '../path-order.ts'
import { isReservedSyncTempFileName } from '../path-safety.ts'
import { validateSyncFilters } from '../regexp-safety.ts'
import { emitScannerSkip, regexpInputTooLongSkip } from '../scan-events.ts'
import { assertScanEntryLimit, scanEntryLimit } from '../scan-limit.ts'
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
  readonly ctimeMs: number
  readonly size: number
  isFile(): boolean
}

type LocalNodeDeps = {
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<LocalDirent[]>
  lstat(path: string): Promise<LocalStats>
  join(...paths: string[]): string
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  sep: string
}

/**
 * Scans a local directory tree and yields {@link LocalSyncPath} entries sorted by relative path.
 * A root directory read failure aborts the scan with an error diagnostic. Per-entry file or
 * directory failures are reported through `onError` and the scan continues over readable siblings.
 * SDK-managed partial download file names are skipped so unfinished internal
 * temp files are not synchronized.
 * The current implementation collects matching entries before sorting, so memory usage is
 * proportional to the number of matched files.
 */
export class LocalFolder implements SyncFolder {
  readonly type = 'local' as const
  readonly appliesScanFilters = true as const
  readonly appliesScanSorting = true as const
  /** Resolved absolute path to the local root directory. */
  readonly root: string

  /**
   * Creates a new LocalFolder for the given root directory.
   * @param root - Absolute or relative path to the local directory to scan.
   */
  constructor(root: string) {
    this.root = resolvePathAtConstruction(root)
    registerLocalFilesystemRoot(this)
  }

  /**
   * Recursively walks the directory and yields files in sync path order.
   * @param options - Optional scan controls.
   */
  async *scan(options: SyncScanOptions = {}): AsyncGenerator<LocalSyncPath> {
    validateSyncFilters(options)
    const nodeDeps = await loadLocalNodeDeps()
    const root = nodeDeps.resolve(this.root)
    const collected: LocalSyncPath[] = []
    await this.walk(root, root, collected, options, scanEntryLimit(options), nodeDeps)
    collected.sort((a, b) => compareSyncRelativePaths(a.relativePath, b.relativePath))
    for (const entry of collected) {
      throwIfScanAborted(options)
      yield entry
    }
  }

  /**
   * Recursively collects files from {@link dir} into {@link out}.
   * @param root - Resolved scan root used for relative path calculation.
   * @param dir - Absolute path of the directory to scan.
   * @param out - Accumulator array that receives discovered file entries.
   * @param options - Optional scan controls.
   * @param maxScanEntries - Maximum number of entries to retain before failing.
   * @param nodeDeps - Lazy-loaded Node filesystem and path helpers.
   */
  private async walk(
    root: string,
    dir: string,
    out: LocalSyncPath[],
    options: SyncScanOptions,
    maxScanEntries: number,
    nodeDeps: LocalNodeDeps,
  ): Promise<void> {
    throwIfScanAborted(options)
    let entries: LocalDirent[]
    try {
      entries = await nodeDeps.readdir(dir, { withFileTypes: true })
    } catch (err) {
      const error = this.emitScanError(
        options,
        relativePathFromRoot(root, dir, nodeDeps),
        'directory',
        err,
      )
      if (dir === root) throw error
      return
    }

    for (const entry of entries) {
      throwIfScanAborted(options)
      const fullPath = nodeDeps.join(dir, entry.name)
      const rel = relativePathFromRoot(root, fullPath, nodeDeps)
      if (
        isDownloadStagingDirectorySegment(rel) &&
        entry.isDirectory() &&
        isDownloadStagingDirectorySegment(entry.name) &&
        (await isManagedDownloadStagingRoot(fullPath))
      ) {
        continue
      }
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
      if (isReservedSyncTempFileName(entry.name)) {
        emitScannerSkip(options, {
          type: 'skip',
          path: rel,
          size: 0,
          reason: 'stale-download-partial',
          message: `Skipped local path ${JSON.stringify(rel)}: reserved SDK partial download file`,
        })
        continue
      }
      // Symlinks, FIFOs, sockets, and device nodes are not syncable files.
      // Ignore them without poisoning delete-mode orphan handling for unrelated paths.
      if (entry.isDirectory()) {
        if (directoryMayContainSyncPaths(rel, options)) {
          await this.walk(root, fullPath, out, options, maxScanEntries, nodeDeps)
        }
      } else if (entry.isFile()) {
        if (!pathPassesSyncFilters(rel, options)) {
          if (pathSkippedByRegExpInputLimit(rel, options)) {
            emitScannerSkip(options, regexpInputTooLongSkip(rel))
          }
          continue
        }
        let s: LocalStats
        try {
          s = await nodeDeps.lstat(fullPath)
          /* v8 ignore start -- lstat race after a Dirent file result is not deterministic */
          if (!s.isFile()) {
            this.emitScanError(options, rel, 'file', new Error('not a regular file'))
            continue
          }
          /* v8 ignore stop */
        } catch (err) {
          /* v8 ignore next -- stat TOCTOU failures are not deterministic to trigger */
          this.emitScanError(options, relativePathFromRoot(root, fullPath, nodeDeps), 'file', err)
          continue
        }
        assertScanEntryLimit(out.length + 1, maxScanEntries)
        out.push({
          relativePath: rel,
          absolutePath: fullPath,
          modTimeMillis: Math.floor(s.mtimeMs),
          size: s.size,
          fileIdentity: localFileIdentityFromStats(s),
        })
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
      message: `failed to scan local ${kind}: ${localFilesystemErrorReason(err)}`,
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
    join: path.join,
    relative: path.relative,
    resolve: path.resolve,
    sep: path.sep,
  }
}

function resolvePathAtConstruction(root: string): string {
  const processLike = (
    globalThis as {
      process?: { cwd?: () => string; platform?: string }
    }
  ).process
  if (typeof processLike?.cwd !== 'function') return root

  const cwd = processLike.cwd()
  if (processLike.platform === 'win32') return resolveWindowsPath(cwd, root)
  return resolvePosixPath(cwd, root)
}

function resolvePosixPath(cwd: string, root: string): string {
  const joined = root.startsWith('/') ? root : `${cwd}/${root}`
  const resolved = normalizePathSegments(joined.split('/'), '/')
  return resolved === '' ? '/' : `/${resolved}`
}

function resolveWindowsPath(cwd: string, root: string): string {
  const normalizedRoot = root.replaceAll('/', '\\')
  const normalizedCwd = cwd.replaceAll('/', '\\')
  const drive = /^[A-Za-z]:/.exec(normalizedCwd)?.[0] ?? ''
  const cwdUnc = splitUncPath(normalizedCwd)
  if (/^\\\\/.test(normalizedRoot)) return normalizeUncPath(normalizedRoot)
  if (/^[A-Za-z]:\\/.test(normalizedRoot)) {
    const prefix = normalizedRoot.slice(0, 2)
    const rest = normalizedRoot.slice(3).split('\\')
    return joinWindowsRoot(prefix, normalizePathSegments(rest, '\\'))
  }
  if (/^[A-Za-z]:/.test(normalizedRoot)) {
    throw new Error('LocalFolder root must not be a drive-relative Windows path')
  }
  if (normalizedRoot.startsWith('\\')) {
    const rest = normalizePathSegments(normalizedRoot.slice(1).split('\\'), '\\')
    return joinWindowsRoot(cwdUnc?.prefix ?? drive, rest)
  }
  if (cwdUnc !== undefined) {
    const resolved = normalizePathSegments([...cwdUnc.rest, ...normalizedRoot.split('\\')], '\\')
    return joinWindowsRoot(cwdUnc.prefix, resolved)
  }
  const base = /^[A-Za-z]:\\/.test(normalizedCwd) ? normalizedCwd : `${drive}\\`
  const prefix = /^[A-Za-z]:/.exec(base)?.[0] ?? drive
  const baseRest = base.slice(prefix.length).replace(/^\\/, '').split('\\')
  const resolved = normalizePathSegments([...baseRest, ...normalizedRoot.split('\\')], '\\')
  return joinWindowsRoot(prefix, resolved)
}

function normalizeUncPath(path: string): string {
  const unc = splitUncPath(path)
  if (unc === undefined) return path
  return joinWindowsRoot(unc.prefix, normalizePathSegments(unc.rest, '\\'))
}

function splitUncPath(
  path: string,
): { readonly prefix: string; readonly rest: string[] } | undefined {
  if (!path.startsWith('\\\\')) return undefined
  const parts = path.split('\\').filter((part) => part !== '')
  const [server, share, ...rest] = parts
  if (server === undefined || share === undefined) return undefined
  return { prefix: `\\\\${server}\\${share}`, rest }
}

function joinWindowsRoot(prefix: string, rest: string): string {
  return rest === '' ? `${prefix}\\` : `${prefix}\\${rest}`
}

function normalizePathSegments(segments: readonly string[], separator: '/' | '\\'): string {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join(separator)
}

function relativePathFromRoot(root: string, path: string, nodeDeps: LocalNodeDeps): string {
  return nodeDeps.relative(root, path).split(nodeDeps.sep).join('/')
}

function throwIfScanAborted(options: SyncScanOptions): void {
  if (options.signal?.aborted === true) {
    throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}
