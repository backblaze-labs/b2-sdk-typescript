import { arrayBufferFor } from '../util/bytes.ts'
import { collectStream } from './collect.ts'

// Keep per-read buffers modest; multipart upload concurrency, not this chunk
// size, controls throughput and the number of simultaneously open file ranges.
const FILE_SOURCE_CHUNK_SIZE = 64 * 1024

interface FileIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

interface FileStatsLike {
  readonly dev: number
  readonly ino: number
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

const fileSourceIdentities = new WeakMap<object, FileIdentity>()

/**
 * Uniform adapter for upload content. Wraps File, Blob, Buffer, file paths,
 * or ReadableStream behind a common interface so upload logic does not depend
 * on the input type.
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
   * `BlobSource`, `FileSource`) — the multipart upload engine can dispatch part reads
   * in parallel by slicing the source into disjoint ranges. `false`
   * for forward-only sources (`StreamSource`) — the engine must read
   * sequentially, one `partSize` chunk at a time. Callers that branch
   * on this flag are expected to fall back to the sequential path
   * rather than call `slice()` and catch the throw.
   */
  readonly canSlice: boolean
  /** Return a sub-range of this source as a new ContentSource. */
  slice(start: number, end: number): ContentSource
  /** Open the content as a ReadableStream. */
  stream(): ReadableStream<Uint8Array>
  /** Read the entire content into an ArrayBuffer. */
  toArrayBuffer(): Promise<ArrayBuffer>
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
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  toArrayBuffer(): Promise<ArrayBuffer> {
    return this.blob.arrayBuffer()
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
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  toArrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.buffer.buffer.slice(
        this.buffer.byteOffset,
        this.buffer.byteOffset + this.buffer.byteLength,
      ) as ArrayBuffer,
    )
  }
}

/**
 * ContentSource backed by a local filesystem path.
 *
 * This class is import-safe in non-Node runtimes so the root and `/streams`
 * barrels remain isomorphic, but reading methods require Node filesystem APIs
 * and will reject when invoked where `node:fs` is unavailable. `FileSource`
 * opens paths with no-follow semantics where Node exposes them. On platforms
 * without `O_NOFOLLOW`, a swapped symlink is opened and then rejected by the
 * post-open identity check. Each slice must still point at the same regular
 * file identity, size, mtime, and ctime captured by
 * {@link FileSource.fromPath}. Concurrent part uploads may open one
 * descriptor per in-flight part; the SDK's upload concurrency bounds that
 * descriptor count.
 */
export class FileSource implements ContentSource {
  /** Absolute or relative path to the underlying local file. */
  readonly filePath: string
  /** {@inheritDoc} */
  readonly size: number
  /** Random-access: each slice opens and reads only its requested byte range. */
  readonly canSlice = true
  private readonly offset: number
  private readonly identity: FileIdentity

  /**
   * Creates a FileSource for a local filesystem path.
   * @param filePath - Path to the underlying file.
   * @param size - Number of bytes exposed by this source.
   * @param identity - Validated regular-file identity, when captured.
   * @param offset - Byte offset where this source begins within the file.
   */
  private constructor(filePath: string, size: number, identity: FileIdentity, offset = 0) {
    assertSafeByteCount(size, 'size')
    assertSafeByteCount(offset, 'offset')
    this.filePath = filePath
    this.size = size
    this.offset = offset
    this.identity = identity
    fileSourceIdentities.set(this, identity)
  }

  /**
   * Creates a FileSource by opening and validating the given filesystem path.
   * @param filePath - Path to the local file.
   *
   * @returns A FileSource sized from the current file metadata.
   *
   * @throws If the path does not resolve to a regular file.
   */
  static async fromPath(filePath: string): Promise<FileSource> {
    const handle = await openNoFollow(filePath)
    try {
      const stats = await handle.stat()
      assertRegularFile(filePath, stats)
      return new FileSource(filePath, stats.size, identityFromStats(stats))
    } finally {
      await handle.close()
    }
  }

  /**
   * Return a new FileSource covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    const sliceStart = clampByteRange(start, this.size)
    const sliceEnd = Math.max(sliceStart, clampByteRange(end, this.size))
    return new FileSource(
      this.filePath,
      sliceEnd - sliceStart,
      this.identity,
      this.offset + sliceStart,
    )
  }

  /**
   * Open the file range as a ReadableStream.
   * @returns A ReadableStream of the file bytes in this source's range.
   */
  stream(): ReadableStream<Uint8Array> {
    const filePath = this.filePath
    const offset = this.offset
    const totalSize = this.size
    const identity = this.identity
    let handle: FileHandleLike | null = null
    let position = offset
    let remaining = totalSize

    async function closeHandle(): Promise<void> {
      const current = handle
      handle = null
      if (current !== null) await current.close()
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (remaining <= 0) {
            if (handle === null) {
              handle = await openValidatedHandle(filePath, identity)
            } else {
              await assertHandleReady(filePath, handle, identity)
            }
            await closeHandle()
            controller.close()
            return
          }

          if (handle === null) {
            handle = await openValidatedHandle(filePath, identity)
          }

          const length = Math.min(FILE_SOURCE_CHUNK_SIZE, remaining)
          const chunk = new Uint8Array(length)
          const { bytesRead } = await handle.read(chunk, 0, length, position)
          if (bytesRead === 0) {
            await assertHandleReady(filePath, handle, identity)
            throw new Error(`FileSource file changed after validation: ${filePath}`)
          }

          position += bytesRead
          remaining -= bytesRead
          controller.enqueue(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead))

          if (remaining === 0) {
            await assertHandleReady(filePath, handle, identity)
            await closeHandle()
            controller.close()
          }
        } catch (err) {
          await closeHandle()
          controller.error(err)
        }
      },

      async cancel() {
        await closeHandle()
      },
    })
  }

  /**
   * Read this file range into an ArrayBuffer.
   * @returns A promise that resolves with the bytes in this source's range.
   */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await collectStream(this.stream())
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer as ArrayBuffer
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
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
   * @returns A promise that resolves with the full content as an ArrayBuffer.
   */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await collectStream(this.stream())
    return arrayBufferFor(bytes)
  }
}

function assertSafeByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`FileSource ${label} must be a non-negative safe integer`)
  }
}

function clampByteRange(value: number, size: number): number {
  if (Number.isNaN(value)) return 0
  // Support Blob/ArrayBuffer-style `slice(start, Infinity)` while keeping
  // negative infinity pinned to the start of the file range.
  if (!Number.isFinite(value)) return value < 0 ? 0 : size
  const offset = Math.trunc(value)
  const relativeOffset = offset < 0 ? size + offset : offset
  return Math.min(size, Math.max(0, relativeOffset))
}

async function openNoFollow(filePath: string): Promise<FileHandleLike> {
  const { constants } = await import('node:fs')
  const { open } = await import('node:fs/promises')
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  return open(filePath, constants.O_RDONLY | noFollow | nonBlock)
}

async function openValidatedHandle(
  filePath: string,
  identity: FileIdentity,
): Promise<FileHandleLike> {
  const handle = await openNoFollow(filePath)
  try {
    await assertHandleReady(filePath, handle, identity)
    return handle
  } catch (err) {
    await handle.close()
    throw err
  }
}

async function assertHandleReady(
  filePath: string,
  handle: FileHandleLike,
  identity: FileIdentity,
): Promise<void> {
  const stats = await handle.stat()
  assertRegularFile(filePath, stats)
  assertSameIdentity(filePath, stats, identity)
}

function assertRegularFile(filePath: string, stats: FileStatsLike): void {
  if (!stats.isFile()) throw new Error(`FileSource path is not a regular file: ${filePath}`)
}

function assertSameIdentity(filePath: string, stats: FileStatsLike, identity: FileIdentity): void {
  if (
    stats.dev !== identity.dev ||
    stats.ino !== identity.ino ||
    stats.size !== identity.size ||
    stats.mtimeMs !== identity.mtimeMs ||
    stats.ctimeMs !== identity.ctimeMs
  ) {
    throw new Error(`FileSource file changed after validation: ${filePath}`)
  }
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

/**
 * Verifies an internal FileSource against a sync scanner identity without
 * exposing sync-only methods on the public FileSource class.
 * @param source - FileSource instance created for the local file.
 * @param identity - Previously scanned local file identity.
 *
 * @throws If the source identity differs from the scanned identity.
 *
 * @internal
 */
export function assertFileSourceMatchesIdentity(
  source: FileSource,
  identity: {
    readonly deviceId: number
    readonly inode: number
    readonly size: number
    readonly modTimeMillis: number
    readonly changeTimeMillis?: number
  },
): void {
  const sourceIdentity = fileSourceIdentities.get(source)
  if (sourceIdentity === undefined) {
    throw new Error(`FileSource file changed after validation: ${source.filePath}`)
  }
  if (
    sourceIdentity.dev !== identity.deviceId ||
    sourceIdentity.ino !== identity.inode ||
    sourceIdentity.size !== identity.size ||
    Math.floor(sourceIdentity.mtimeMs) !== identity.modTimeMillis ||
    (identity.changeTimeMillis !== undefined &&
      Math.floor(sourceIdentity.ctimeMs) !== identity.changeTimeMillis)
  ) {
    throw new Error(`FileSource file changed after validation: ${source.filePath}`)
  }
}

/**
 * Convert a Uint8Array, Blob, or ReadableStream into a {@link ContentSource}.
 * When passing a ReadableStream, the `size` parameter is required.
 * @param input - The content to wrap, as a Uint8Array, Blob, or ReadableStream.
 * @param size - The total byte length, required when input is a ReadableStream.
 *
 * @returns A ContentSource adapter for the given input.
 *
 * @throws If input is a ReadableStream and size is not provided.
 */
export function toContentSource(
  input: Uint8Array | Blob | ReadableStream<Uint8Array>,
  size?: number,
): ContentSource {
  if (input instanceof Uint8Array) {
    return new BufferSource(input)
  }
  if (input instanceof Blob) {
    return new BlobSource(input)
  }
  if (size === undefined) {
    throw new Error('size is required when using a ReadableStream as input.')
  }
  return new StreamSource(input, size)
}
