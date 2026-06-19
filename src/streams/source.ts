import { arrayBufferFor } from '../util/bytes.ts'
import { collectStream } from './collect.ts'

const FILE_READ_CHUNK_SIZE = 64 * 1024

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
  readonly mode: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

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
      'FileSource constructor requires Node.js 22.3+ synchronous filesystem APIs; use FileSource.fromPath() in older Node 22 runtimes.',
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
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
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
    mode: stats.mode,
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
  assertStableIdentity(path, stats)
  return identityFromStats(stats)
}

function assertSameIdentity(
  path: FileSourcePath,
  expected: FileIdentity,
  actual: FileStatsLike,
  when: string,
): void {
  assertStableIdentity(path, actual)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode) {
    throw new Error(`FileSource: ${formatFilePath(path)} changed ${when}.`)
  }
  if (
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs ||
    actual.ctimeMs !== expected.ctimeMs
  ) {
    throw new Error(`FileSource: ${formatFilePath(path)} was modified ${when}.`)
  }
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
  const { open } = (await import('node:fs/promises')) as {
    open(path: FileSourcePath, flags: number): Promise<FileHandleLike>
  }
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
): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0)

  const file = await openValidatedFile(path, identity)
  const data = new Uint8Array(size)
  let filled = 0
  try {
    while (filled < data.byteLength) {
      const { bytesRead } = await file.read(data, filled, data.byteLength - filled, offset + filled)
      if (bytesRead === 0) throw rangeEndedEarlyError(path, offset, size)
      filled += bytesRead
    }
    const stats = await file.stat()
    assertSameIdentity(path, identity, stats, 'while being read')
    return data
  } finally {
    /* v8 ignore next -- Cleanup failure is deliberately best-effort. */
    await file.close().catch(() => {})
  }
}

function asyncIterableToReadableStream(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done === true) {
          controller.close()
          return
        }
        if (!(value instanceof Uint8Array)) {
          throw new TypeError('Async iterable content sources must yield Uint8Array chunks.')
        }
        controller.enqueue(value)
      } catch (err) {
        /* v8 ignore next -- Iterator-return failure must not mask the pull error. */
        await iterator.return?.().catch(() => {})
        throw err
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

function isAsyncIterable(input: unknown): input is AsyncIterable<Uint8Array> {
  return (
    typeof input === 'object' &&
    input !== null &&
    Symbol.asyncIterator in input &&
    typeof input[Symbol.asyncIterator] === 'function'
  )
}

function isReadableStream(input: unknown): input is ReadableStream<Uint8Array> {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { getReader?: unknown }).getReader === 'function'
  )
}

/**
 * Uniform adapter for upload content. Wraps File, Blob, Buffer, local files,
 * async iterables, or ReadableStream behind a common interface so upload logic
 * does not depend on the input type.
 */
export interface ContentSource {
  /** Total size of the content in bytes. */
  readonly size: number
  /** Pre-computed SHA-1 hex digest, if available. */
  readonly sha1?: string
  /**
   * Whether {@link slice} is safe to call on this source.
   *
   * `true` for in-memory / random-access sources (`BufferSource`,
   * `BlobSource`, `FileSource`) — the multipart upload engine can dispatch
   * part reads in parallel by slicing the source into disjoint ranges.
   * `false` for forward-only streams and async iterables — the engine must
   * read sequentially, one `partSize` chunk at a time. Callers that branch on
   * this flag are expected to fall back to the sequential path rather than call
   * `slice()` and catch the throw.
   */
  readonly canSlice: boolean
  /** Return a sub-range of this source as a new ContentSource. */
  slice(start: number, end: number): ContentSource
  /** Open the content as a ReadableStream. */
  stream(): ReadableStream<Uint8Array>
  /** Read the entire content into an ArrayBuffer. */
  toArrayBuffer(options?: { readonly signal?: AbortSignal }): Promise<ArrayBuffer>
}

/** ContentSource backed by a Blob or File. */
export class BlobSource implements ContentSource {
  /** {@inheritDoc} */
  readonly size: number
  /** Random-access: `Blob.slice()` is cheap and returns a new Blob view. */
  readonly canSlice = true

  /**
   * Create a BlobSource wrapping the given Blob.
   * @param blob - The Blob or File to use as the underlying content.
   */
  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }

  /**
   * Return a new BlobSource covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    return new BlobSource(this.blob.slice(start, end))
  }

  /**
   * Open the Blob content as a ReadableStream.
   * @returns A ReadableStream of the Blob bytes.
   */
  stream(): ReadableStream<Uint8Array> {
    return this.blob.stream() as ReadableStream<Uint8Array>
  }

  /**
   * Read the entire Blob content into an ArrayBuffer.
   * @param options - Optional abort signal used while reading.
   *
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  async toArrayBuffer(options: { readonly signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
    options.signal?.throwIfAborted()
    if (options.signal === undefined) return this.blob.arrayBuffer()
    const bytes = await collectStream(this.stream(), options)
    return arrayBufferFor(bytes)
  }
}

/** ContentSource backed by a Uint8Array buffer. */
export class BufferSource implements ContentSource {
  /** {@inheritDoc} */
  readonly size: number
  /** Random-access: the entire payload lives in memory. */
  readonly canSlice = true

  /**
   * Create a BufferSource wrapping the given Uint8Array.
   * @param buffer - The byte buffer to use as the underlying content.
   */
  constructor(private readonly buffer: Uint8Array) {
    this.size = buffer.byteLength
  }

  /**
   * Return a new BufferSource covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    return new BufferSource(this.buffer.slice(start, end))
  }

  /**
   * Open the buffer content as a ReadableStream.
   * @returns A ReadableStream that emits the buffer bytes in a single chunk.
   */
  stream(): ReadableStream<Uint8Array> {
    const buffer = this.buffer
    return new ReadableStream({
      start(controller) {
        controller.enqueue(buffer)
        controller.close()
      },
    })
  }

  /**
   * Read the entire buffer content into an ArrayBuffer.
   * @param options - Optional abort signal checked before returning the buffer.
   *
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  toArrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(arrayBufferFor(this.buffer))
  }
}

abstract class FileRangeSource implements ContentSource {
  /** Random-access: file ranges are read by absolute byte offset. */
  readonly canSlice = true

  /**
   * @param path - Local filesystem path or file URL.
   * @param identity - File identity captured when the root FileSource was constructed.
   * @param offset - Absolute byte offset where this source starts.
   * @param size - Number of bytes in this source.
   */
  protected constructor(
    protected readonly path: FileSourcePath,
    private readonly identity: FileIdentity,
    private readonly offset: number,
    readonly size: number,
  ) {}

  /**
   * Return a new file-backed source covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    const normalizedStart = normalizeSliceOffset(start, this.size)
    const normalizedEnd = normalizeSliceOffset(end, this.size)
    return new FileSliceSource(
      this.path,
      this.identity,
      this.offset + normalizedStart,
      Math.max(normalizedEnd - normalizedStart, 0),
    )
  }

  /**
   * Open this file range as a Web ReadableStream.
   * @returns A ReadableStream that reads the configured file range lazily.
   */
  stream(): ReadableStream<Uint8Array> {
    const path = this.path
    const identity = this.identity
    let position = this.offset
    let remaining = this.size

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (remaining === 0) {
          controller.close()
          return
        }

        const length = Math.min(FILE_READ_CHUNK_SIZE, remaining)
        // Open per pull so an abandoned public stream cannot strand a file descriptor.
        const data = await readFileRange(path, identity, position, length)

        position += data.byteLength
        remaining -= data.byteLength
        controller.enqueue(data)
        if (remaining === 0) controller.close()
      },
    })
  }

  /**
   * Read this file range into an ArrayBuffer.
   * @returns A promise resolving with exactly this source's byte range.
   */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const data = await readFileRange(this.path, this.identity, this.offset, this.size)
    return data.buffer as ArrayBuffer
  }
}

class FileSliceSource extends FileRangeSource {}

/**
 * ContentSource backed by a local filesystem path.
 *
 * `FileSource` is Node-only but safe to import in browser builds: it touches
 * Node filesystem APIs only when constructed or read. The constructor validates
 * the path synchronously so `size` is immediately available; async code paths
 * that construct many sources should use {@link FileSource.fromPath}. Both paths
 * validate a regular, non-symlink file identity; reads reject if the path is
 * replaced, if the filesystem cannot report stable identity, or if the file is
 * modified before the configured byte range is read. Slices preserve that
 * captured identity, so multipart uploads can read disjoint ranges without
 * materialising the whole file in memory or following later path swaps.
 */
export class FileSource extends FileRangeSource {
  /**
   * Create a FileSource for a local file path.
   * @param path - Local filesystem path or file URL.
   *
   * @throws If the runtime has no Node-compatible filesystem API.
   * @throws If the path does not reference a regular non-symlink file.
   * @throws If the filesystem cannot report stable file identity.
   */
  constructor(path: FileSourcePath)
  /**
   * Internal constructor path used by {@link FileSource.fromPath}.
   * @param path - Local filesystem path or file URL.
   * @param identity - Prevalidated file identity.
   *
   * @internal
   */
  constructor(path: FileSourcePath, identity?: FileIdentity) {
    const resolvedIdentity =
      identity ?? validatedIdentityFromStats(path, getNodeFsSync().lstatSync(path))
    super(path, resolvedIdentity, 0, resolvedIdentity.size)
  }

  /**
   * Create a FileSource using asynchronous filesystem validation.
   * @param path - Local filesystem path or file URL.
   *
   * @returns A FileSource bound to the validated file identity.
   *
   * @throws If the path does not reference a regular non-symlink file.
   * @throws If the filesystem cannot report stable file identity.
   */
  static async fromPath(path: FileSourcePath): Promise<FileSource> {
    const identity = validatedIdentityFromStats(path, await lstatNodeFile(path))
    const InternalCtor = FileSource as unknown as {
      new (path: FileSourcePath, identity: FileIdentity): FileSource
    }
    return new InternalCtor(path, identity)
  }
}

/** ContentSource backed by a ReadableStream. Can only be consumed once and does not support slicing. */
export class StreamSource implements ContentSource {
  /** {@inheritDoc} */
  readonly size: number
  /**
   * Forward-only: ReadableStreams cannot be repositioned, so multipart
   * uploads must take the sequential path. See the interface comment on
   * `canSlice` for what the engine does with this flag.
   */
  readonly canSlice = false
  /** Whether the stream has already been read. */
  private consumed = false

  /**
   * Create a StreamSource wrapping the given ReadableStream with a known byte size.
   * @param readable - The ReadableStream to wrap as a content source.
   * @param size - The total number of bytes the stream will produce.
   */
  constructor(
    private readonly readable: ReadableStream<Uint8Array>,
    size: number,
  ) {
    this.size = size
  }

  /**
   * Always throws because streams cannot be sliced. Buffer the stream first.
   *
   * @throws If slicing is attempted on a stream-backed source.
   */
  slice(): ContentSource {
    throw new Error('StreamSource does not support slicing. Buffer the stream first.')
  }

  /**
   * Open the underlying ReadableStream. Can only be called once.
   * @returns The underlying ReadableStream of bytes.
   *
   * @throws If the stream has already been consumed.
   */
  stream(): ReadableStream<Uint8Array> {
    if (this.consumed) throw new Error('StreamSource can only be consumed once.')
    this.consumed = true
    return this.readable
  }

  /**
   * Read the entire stream into an ArrayBuffer.
   * @param options - Optional abort signal used while reading.
   *
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  async toArrayBuffer(options: { readonly signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
    const bytes = await collectStream(this.stream(), options)
    return arrayBufferFor(bytes)
  }
}

/** ContentSource backed by a forward-only async iterable of Uint8Array chunks. */
class AsyncIterableSource extends StreamSource {
  /**
   * Create an AsyncIterableSource from a known-size async iterable.
   * @param iterable - Async iterable that yields Uint8Array chunks.
   * @param size - Total byte length the iterable will produce.
   */
  constructor(iterable: AsyncIterable<Uint8Array>, size: number) {
    super(asyncIterableToReadableStream(iterable), size)
  }
}

/**
 * Convert a Uint8Array, Blob, ReadableStream, or async iterable into a {@link ContentSource}.
 * When passing a ReadableStream or async iterable, the `size` parameter is required.
 * @param input - The content to wrap.
 * @param size - The total byte length, required for forward-only inputs.
 *
 * @returns A ContentSource adapter for the given input.
 *
 * @throws If input is forward-only and size is not provided.
 */
export function toContentSource(
  input: Uint8Array | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  size?: number,
): ContentSource {
  if (input instanceof Uint8Array) {
    return new BufferSource(input)
  }
  if (input instanceof Blob) {
    return new BlobSource(input)
  }
  if (isReadableStream(input)) {
    if (size === undefined) {
      throw new Error('size is required when using a forward-only content source as input.')
    }
    return new StreamSource(input, size)
  }
  if (isAsyncIterable(input)) {
    if (size === undefined) {
      throw new Error('size is required when using a forward-only content source as input.')
    }
    return new AsyncIterableSource(input, size)
  }
  throw new TypeError('Unsupported content source input.')
}
