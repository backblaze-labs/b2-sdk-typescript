import { arrayBufferFor } from '../util/bytes.ts'

const FILE_STREAM_CHUNK_SIZE = 16 * 1024 * 1024
const READABLE_STREAM_SIZE_REQUIRED_ERROR = 'size is required when using a ReadableStream as input.'
const FORWARD_ONLY_SIZE_REQUIRED_ERROR =
  'size is required when using a forward-only content source as input.'
const STREAM_SOURCE_ENDED_EARLY_ERROR = 'StreamSource ended before the advertised byte count.'
const STREAM_SOURCE_TOO_MANY_BYTES_ERROR =
  'StreamSource emitted more bytes than the advertised byte count.'
const STREAM_SOURCE_TOO_MANY_EMPTY_CHUNKS_ERROR =
  'StreamSource emitted too many empty chunks without data.'
/** Maximum consecutive empty chunks tolerated from a forward-only stream. */
export const MAX_EMPTY_STREAM_CHUNKS = 1024

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

const FILE_SOURCE_INTERNAL = Symbol('FileSource.internal')

interface FileSourceInternalOptions {
  readonly key: typeof FILE_SOURCE_INTERNAL
  readonly identity: FileIdentity
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
  // O_NOFOLLOW is unavailable on some platforms. When it is absent, the
  // post-open fstat identity check below is the symlink-swap defense.
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
  if (
    shouldComparePosixIdentity() &&
    (actual.dev !== expected.dev || actual.ino !== expected.ino)
  ) {
    throw new Error(`FileSource: ${formatFilePath(path)} changed ${when}.`)
  }
  if (actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new Error(`FileSource: ${formatFilePath(path)} was modified ${when}.`)
  }
  if (shouldComparePosixIdentity() && actual.ctimeMs !== expected.ctimeMs) {
    throw new Error(`FileSource: ${formatFilePath(path)} was modified ${when}.`)
  }
}

function shouldComparePosixIdentity(): boolean {
  return !isWindows()
}

function isWindows(): boolean {
  const processLike = (globalThis as { process?: { platform?: string } }).process
  return processLike?.platform === 'win32'
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
  if (size === 0) {
    await verifyFileIdentityForEmptyRead(path, identity)
    return new Uint8Array(0)
  }

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

async function verifyFileIdentityForEmptyRead(
  path: FileSourcePath,
  identity: FileIdentity,
): Promise<void> {
  const file = await openValidatedFile(path, identity)
  try {
    return
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
    protected readonly identity: FileIdentity,
    protected readonly offset: number,
    readonly size: number,
  ) {}

  /**
   * Create a concrete file-backed source for a sub-range.
   * @param path - Local filesystem path or file URL.
   * @param identity - File identity captured when the root FileSource was constructed.
   * @param offset - Absolute byte offset where this source starts.
   * @param size - Number of bytes in this source.
   *
   * @returns A ContentSource representing the requested range.
   */
  protected createSlice(
    path: FileSourcePath,
    identity: FileIdentity,
    offset: number,
    size: number,
  ): ContentSource {
    return new FileSliceSource(path, identity, offset, size)
  }

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
    return this.createSlice(
      this.path,
      this.identity,
      this.offset + normalizedStart,
      Math.max(normalizedEnd - normalizedStart, 0),
    )
  }

  /**
   * Verify that the file range still points at the captured file identity.
   * @param when - Context included in any thrown error message.
   */
  protected async verifyUnchanged(when: string): Promise<void> {
    const stats = await lstatNodeFile(this.path)
    assertRegularFile(this.path, stats)
    assertSameIdentity(this.path, this.identity, stats, when)
  }

  /**
   * Open this file range as a Web ReadableStream.
   *
   * The stream opens, verifies, reads, and closes the file for each large
   * chunk. Closing after every pull prevents abandoned public streams from
   * stranding a descriptor while the large chunk size keeps syscall overhead
   * bounded for multi-GB reads.
   *
   * @returns A ReadableStream that reads the configured file range lazily.
   */
  stream(): ReadableStream<Uint8Array> {
    const path = this.path
    const identity = this.identity
    let position = this.offset
    let remaining = this.size
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

  /**
   * Read this file range into an ArrayBuffer.
   * @returns A promise resolving with exactly this source's byte range.
   */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const data = await readFileRange(this.path, this.identity, this.offset, this.size)
    return data.buffer as ArrayBuffer
  }
}

// Concrete range source returned by FileRangeSource.slice().
class FileSliceSource extends FileRangeSource {}

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
 * identity, or if size/mtime changes before the configured byte range is read.
 * On POSIX platforms, ctime changes are also rejected so same-size rewrites
 * that restore mtime are detected. On Windows, a same-size rewrite with a
 * restored mtime can be undetectable through Node's portable stat fields; use
 * an independent digest when a caller must prove the bytes are unchanged.
 * Slices preserve the captured identity, so multipart uploads can read
 * disjoint ranges without materialising the whole file in memory or following
 * later leaf path swaps.
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
    validateStreamSourceSize(size)
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
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await collectStreamExactly(this.stream(), this.size)
    return bytes.buffer as ArrayBuffer
  }
}

function validateStreamSourceSize(size: number): void {
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < 0) {
    throw new RangeError('StreamSource size must be a non-negative finite integer.')
  }
}

async function collectStreamExactly(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let completed = false

  try {
    while (total < expectedSize) {
      const { done, value } = await readNextNonEmptyStreamChunk(
        reader,
        STREAM_SOURCE_TOO_MANY_EMPTY_CHUNKS_ERROR,
      )
      if (done) throw new Error(STREAM_SOURCE_ENDED_EARLY_ERROR)
      if (total + value.byteLength > expectedSize) {
        throw new Error(STREAM_SOURCE_TOO_MANY_BYTES_ERROR)
      }
      chunks.push(value)
      total += value.byteLength
    }

    const extra = await readNextNonEmptyStreamChunk(
      reader,
      STREAM_SOURCE_TOO_MANY_EMPTY_CHUNKS_ERROR,
    )
    if (!extra.done) throw new Error(STREAM_SOURCE_TOO_MANY_BYTES_ERROR)

    const result = new Uint8Array(expectedSize)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    completed = true
    return result
  } finally {
    if (!completed) {
      /* v8 ignore next -- Reader cancellation failure is deliberately best-effort. */
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

/**
 * Reads from a stream until it receives data, EOF, or too many consecutive empty chunks.
 * @param reader - Locked reader for a Uint8Array stream.
 * @param emptyChunkErrorMessage - Error message to throw when the empty-chunk limit is exceeded.
 * @param signal - Optional abort signal that cancels the reader and rejects the read.
 *
 * @returns The next non-empty chunk or EOF result.
 */
export async function readNextNonEmptyStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  emptyChunkErrorMessage: string,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let emptyChunks = 0
  while (true) {
    const result = await readStreamChunk(reader, signal)
    if (result.done || result.value.byteLength > 0) return result
    emptyChunks += 1
    if (emptyChunks > MAX_EMPTY_STREAM_CHUNKS) {
      throw new Error(emptyChunkErrorMessage)
    }
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read()
  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => {})
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }

  let removeAbortListener: (() => void) | undefined
  const abort = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      void reader.cancel(signal.reason).catch(() => {})
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([reader.read(), abort])
  } finally {
    removeAbortListener?.()
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
      throw new Error(READABLE_STREAM_SIZE_REQUIRED_ERROR)
    }
    return new StreamSource(input, size)
  }
  if (isAsyncIterable(input)) {
    if (size === undefined) {
      throw new Error(FORWARD_ONLY_SIZE_REQUIRED_ERROR)
    }
    return new AsyncIterableSource(input, size)
  }
  throw new TypeError('Unsupported content source input.')
}
