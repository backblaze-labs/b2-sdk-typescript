import type { ContentSource } from './source.ts'

const FILE_STREAM_CHUNK_SIZE = 16 * 1024 * 1024

/** Filesystem path accepted by {@link FileSource}. */
export type FileSourcePath = string | URL

interface FileStatsLike {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  isFile(): boolean
}

interface FileHandleLike {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  stat(): Promise<FileStatsLike>
  close(): Promise<void>
}

interface NodeFsSync {
  lstatSync(path: FileSourcePath): FileStatsLike
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

interface ToArrayBufferOptions {
  readonly signal?: AbortSignal
}

const FILE_SOURCE_INTERNAL = Symbol('FileSource.internal')

interface FileSourceInternalOptions {
  readonly key: typeof FILE_SOURCE_INTERNAL
  readonly identity: FileIdentity
}

/** @internal */
export const fileSourceTestHooks: {
  afterReadIteration?: (filled: number) => Promise<void> | void
  maxReadSize?: number
  openFile?: (path: FileSourcePath, flags: number) => Promise<FileHandleLike>
  platform?: string
} = {}

function getNodeFsSync(): NodeFsSync {
  // FileSource exposes `size` synchronously, so the constructor cannot use the
  // repo's usual `await import('node:...')` pattern for Node-only APIs. Keep the
  // synchronous lookup here; async callers should prefer `FileSource.fromPath()`.
  const processLike = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown }
    }
  ).process
  const fs = processLike?.getBuiltinModule?.('node:fs')
  if (!isNodeFsSync(fs)) {
    throw new Error(
      'FileSource constructor requires Node.js 22.3+ synchronous filesystem APIs; use FileSource.fromPath() when synchronous filesystem access is unavailable.',
    )
  }
  return fs
}

function isNodeFsSync(value: unknown): value is NodeFsSync {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['lstatSync'] === 'function'
}

async function fileOpenFlags(): Promise<number> {
  const { constants } = await import('node:fs')
  // O_NOFOLLOW and O_NONBLOCK are unavailable on some platforms. When
  // O_NOFOLLOW is absent, the post-open fstat identity check below is the
  // symlink-swap defense. O_NONBLOCK avoids blocking indefinitely if a path is
  // swapped to a FIFO or another blocking special file before fstat rejects it.
  return (
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0)
  )
}

function normalizeSliceOffset(value: number, size: number): number {
  if (!Number.isFinite(value)) throw new RangeError('FileSource slice offsets must be finite.')
  const integer = Math.trunc(value)
  const offset = integer < 0 ? size + integer : integer
  return Math.min(Math.max(offset, 0), size)
}

function formatFilePath(path: FileSourcePath): string {
  return path instanceof URL ? path.href : path
}

function identityFromStats(stats: FileStatsLike): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
}

function assertStableIdentity(path: FileSourcePath, stats: FileStatsLike): void {
  if (stats.dev === 0 && stats.ino === 0) {
    throw new Error(
      `FileSource: ${formatFilePath(path)} is on a filesystem that does not expose stable file identity.`,
    )
  }
}

function assertRegularFile(path: FileSourcePath, stats: FileStatsLike): void {
  if (!stats.isFile()) {
    throw new Error(`FileSource: ${formatFilePath(path)} is not a regular file.`)
  }
}

function validatedIdentityFromStats(path: FileSourcePath, stats: FileStatsLike): FileIdentity {
  assertRegularFile(path, stats)
  if (shouldComparePosixFileIdentity()) assertStableIdentity(path, stats)
  return identityFromStats(stats)
}

function assertSameIdentity(
  path: FileSourcePath,
  expected: FileIdentity,
  actual: FileStatsLike,
  when: string,
): void {
  if (shouldComparePosixFileIdentity()) assertStableIdentity(path, actual)
  if (
    shouldComparePosixFileIdentity() &&
    (actual.dev !== expected.dev || actual.ino !== expected.ino)
  ) {
    throw new Error(`FileSource: ${formatFilePath(path)} changed ${when}.`)
  }
  if (actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new Error(`FileSource: ${formatFilePath(path)} was modified ${when}.`)
  }
  if (shouldComparePosixChangeTime() && actual.ctimeMs !== expected.ctimeMs) {
    throw new Error(`FileSource: ${formatFilePath(path)} was modified ${when}.`)
  }
}

function isWindows(): boolean {
  if (fileSourceTestHooks.platform !== undefined) return fileSourceTestHooks.platform === 'win32'
  const processLike = (globalThis as { process?: { platform?: string } }).process
  return processLike?.platform === 'win32'
}

function shouldComparePosixFileIdentity(): boolean {
  return !isWindows()
}

function shouldComparePosixChangeTime(): boolean {
  return !isWindows()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined || !signal.aborted) return
  throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function maxReadSize(): number {
  return fileSourceTestHooks.maxReadSize ?? FILE_STREAM_CHUNK_SIZE
}

/* v8 ignore start -- Requires a file to pass identity checks and still EOF mid-range. */
function rangeEndedEarlyError(path: FileSourcePath, offset: number, size: number): Error {
  const end = offset + size
  return new Error(
    `FileSource: ${formatFilePath(path)} ended before byte range [${offset}, ${end}) was fully read.`,
  )
}
/* v8 ignore stop */

async function openValidatedFile(
  path: FileSourcePath,
  identity: FileIdentity,
): Promise<FileHandleLike> {
  const open =
    fileSourceTestHooks.openFile ??
    (
      (await import('node:fs/promises')) as {
        open(path: FileSourcePath, flags: number): Promise<FileHandleLike>
      }
    ).open
  let file: FileHandleLike
  try {
    file = await open(path, await fileOpenFlags())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`FileSource: ${formatFilePath(path)} could not be opened: ${message}`)
  }

  try {
    const stats = await file.stat()
    assertRegularFile(path, stats)
    assertSameIdentity(path, identity, stats, 'before read')
    return file
  } catch (err) {
    /* v8 ignore next -- Cleanup failure is deliberately best-effort. */
    await file.close().catch(() => {})
    throw err
  }
}

async function lstatNodeFile(path: FileSourcePath): Promise<FileStatsLike> {
  const { lstat } = (await import('node:fs/promises')) as {
    lstat(path: FileSourcePath): Promise<FileStatsLike>
  }
  return lstat(path)
}

async function readFileRange(
  path: FileSourcePath,
  identity: FileIdentity,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal)
  if (size === 0) {
    await verifyFileIdentityForEmptyRead(path, identity, signal)
    return new Uint8Array(0)
  }

  throwIfAborted(signal)
  const file = await openValidatedFile(path, identity)
  const data = new Uint8Array(size)
  let filled = 0
  try {
    while (filled < data.byteLength) {
      throwIfAborted(signal)
      const length = Math.min(maxReadSize(), data.byteLength - filled)
      const { bytesRead } = await file.read(data, filled, length, offset + filled)
      if (bytesRead === 0) throw rangeEndedEarlyError(path, offset, size)
      filled += bytesRead
      await fileSourceTestHooks.afterReadIteration?.(filled)
    }
    throwIfAborted(signal)
    const stats = await file.stat()
    assertSameIdentity(path, identity, stats, 'while being read')
    return data
  } finally {
    /* v8 ignore next -- Cleanup failure is deliberately best-effort. */
    await file.close().catch(() => {})
  }
}

async function verifyFileIdentityForEmptyRead(
  path: FileSourcePath,
  identity: FileIdentity,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  const file = await openValidatedFile(path, identity)
  try {
    throwIfAborted(signal)
    return
  } finally {
    /* v8 ignore next -- Cleanup failure is deliberately best-effort. */
    await file.close().catch(() => {})
  }
}

function sliceFileRange(
  path: FileSourcePath,
  identity: FileIdentity,
  offset: number,
  size: number,
  start: number,
  end: number,
): ContentSource {
  const normalizedStart = normalizeSliceOffset(start, size)
  const normalizedEnd = normalizeSliceOffset(end, size)
  return new FileSliceSource(
    path,
    identity,
    offset + normalizedStart,
    Math.max(normalizedEnd - normalizedStart, 0),
  )
}

function streamFileRange(
  path: FileSourcePath,
  identity: FileIdentity,
  offset: number,
  size: number,
): ReadableStream<Uint8Array> {
  let position = offset
  let remaining = size
  let verifiedEmpty = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (remaining === 0) {
          if (!verifiedEmpty) {
            verifiedEmpty = true
            await verifyFileIdentityForEmptyRead(path, identity)
          }
          controller.close()
          return
        }

        const length = Math.min(FILE_STREAM_CHUNK_SIZE, remaining)
        const data = await readFileRange(path, identity, position, length)
        position += data.byteLength
        remaining -= data.byteLength
        controller.enqueue(data)
        if (remaining === 0) controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

async function fileRangeToArrayBuffer(
  path: FileSourcePath,
  identity: FileIdentity,
  offset: number,
  size: number,
  options: ToArrayBufferOptions = {},
): Promise<ArrayBuffer> {
  const data = await readFileRange(path, identity, offset, size, options.signal)
  return data.buffer as ArrayBuffer
}

class FileSliceSource implements ContentSource {
  readonly canSlice = true

  constructor(
    private readonly path: FileSourcePath,
    private readonly identity: FileIdentity,
    private readonly offset: number,
    readonly size: number,
  ) {}

  slice(start: number, end: number): ContentSource {
    return sliceFileRange(this.path, this.identity, this.offset, this.size, start, end)
  }

  stream(): ReadableStream<Uint8Array> {
    return streamFileRange(this.path, this.identity, this.offset, this.size)
  }

  toArrayBuffer(options: ToArrayBufferOptions = {}): Promise<ArrayBuffer> {
    return fileRangeToArrayBuffer(this.path, this.identity, this.offset, this.size, options)
  }
}

/**
 * ContentSource backed by a local filesystem path.
 *
 * `FileSource` is Node-only but safe to import in browser builds: it touches
 * Node filesystem APIs only when constructed or read. The constructor performs
 * synchronous filesystem validation so `size` is immediately available; request
 * handlers, sync loops, and other latency-sensitive code should use
 * {@link FileSource.fromPath}. Both paths capture a best-effort regular file
 * identity and reject a symlink as the final path component; parent directory
 * symlinks are followed by the operating system, so callers that constrain
 * paths under a trusted root should validate those parents separately. Reads
 * reject if the path is replaced, if the filesystem cannot report stable
 * identity on POSIX platforms, or if size/mtime/ctime changes before the
 * configured byte range is read. On Windows, reads avoid unreliable dev/inode
 * identity comparisons and validate size/mtime instead.
 * Slices preserve the captured identity, so multipart uploads can read
 * disjoint ranges without materialising the whole file in memory or following
 * later leaf path swaps.
 */
export class FileSource implements ContentSource {
  /** Random-access: file ranges are read by absolute byte offset. */
  readonly canSlice = true
  /** File size captured at construction time. */
  readonly size: number
  private readonly path: FileSourcePath
  private readonly identity: FileIdentity

  /**
   * Create a FileSource for a local file path.
   * @param path - Local filesystem path or file URL.
   *
   * @throws If the runtime has no Node-compatible filesystem API.
   * @throws If the path does not reference a regular non-symlink file.
   * @throws If a POSIX filesystem cannot report stable file identity.
   */
  constructor(path: FileSourcePath)
  /**
   * Internal constructor path for async validation.
   * @param path - Local filesystem path or file URL.
   * @param internal - Module-private validated identity payload.
   *
   * @internal
   */
  constructor(path: FileSourcePath, internal?: FileSourceInternalOptions) {
    const resolvedIdentity =
      internal?.key === FILE_SOURCE_INTERNAL
        ? internal.identity
        : validatedIdentityFromStats(path, getNodeFsSync().lstatSync(path))
    this.path = path
    this.identity = resolvedIdentity
    this.size = resolvedIdentity.size
  }

  /**
   * Return a new file-backed source covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    return sliceFileRange(this.path, this.identity, 0, this.size, start, end)
  }

  /**
   * Open this file as a Web ReadableStream.
   * @returns A ReadableStream that reads the file lazily.
   */
  stream(): ReadableStream<Uint8Array> {
    return streamFileRange(this.path, this.identity, 0, this.size)
  }

  /**
   * Read this file into an ArrayBuffer.
   * @param options - Optional abort signal used while reading.
   *
   * @returns A promise resolving with the file bytes.
   */
  toArrayBuffer(options: ToArrayBufferOptions = {}): Promise<ArrayBuffer> {
    return fileRangeToArrayBuffer(this.path, this.identity, 0, this.size, options)
  }

  /**
   * Create a FileSource using asynchronous filesystem validation.
   * @param path - Local filesystem path or file URL.
   *
   * @returns A FileSource bound to the validated file identity.
   *
   * @throws If the path does not reference a regular non-symlink file.
   * @throws If a POSIX filesystem cannot report stable file identity.
   */
  static async fromPath(path: FileSourcePath): Promise<FileSource> {
    const identity = validatedIdentityFromStats(path, await lstatNodeFile(path))
    return constructFileSourceFromIdentity(path, identity)
  }
}

function constructFileSourceFromIdentity(path: FileSourcePath, identity: FileIdentity): FileSource {
  // The public overload is intentionally single-argument; Reflect.construct
  // lets fromPath pass the module-private validated identity without exposing
  // that constructor shape in the public type surface.
  return Reflect.construct(FileSource, [
    path,
    { key: FILE_SOURCE_INTERNAL, identity },
  ]) as FileSource
}
