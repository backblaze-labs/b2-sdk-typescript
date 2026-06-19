import { arrayBufferFor } from '../util/bytes.ts'
import { collectStream } from './collect.ts'

const FILE_READ_CHUNK_SIZE = 64 * 1024

/** Filesystem path accepted by {@link FileSource}. */
export type FileSourcePath = string | URL

/** Optional range override used by {@link FileSource}. */
export interface FileSourceOptions {
  /** Absolute byte offset where this source begins. Defaults to `0`. */
  readonly offset?: number
  /**
   * Number of bytes exposed by this source. When omitted, `FileSource`
   * synchronously stats the file and uses the remaining bytes after
   * {@link FileSourceOptions.offset}.
   */
  readonly size?: number
}

interface NodeFileStat {
  readonly size: number
  isFile(): boolean
}

interface NodeFsSync {
  statSync(path: FileSourcePath): NodeFileStat
}

interface NodeFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>
  close(): Promise<void>
}

interface NodeFsPromises {
  open(path: FileSourcePath, flags: 'r'): Promise<NodeFileHandle>
}

function getNodeFsSync(): NodeFsSync {
  const processLike = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown }
    }
  ).process
  const fs = processLike?.getBuiltinModule?.('node:fs') as NodeFsSync | undefined
  if (fs === undefined) {
    throw new Error('FileSource is only available in Node.js-compatible runtimes.')
  }
  return fs
}

async function openNodeFile(path: FileSourcePath): Promise<NodeFileHandle> {
  const fs = (await import('node:fs/promises')) as NodeFsPromises
  return fs.open(path, 'r')
}

function validateByteCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`)
  }
}

function normalizeSliceOffset(value: number, size: number): number {
  if (!Number.isFinite(value)) throw new RangeError('FileSource slice offsets must be finite.')
  const offset = value < 0 ? size + value : value
  return Math.min(Math.max(offset, 0), size)
}

function rangeEndedEarlyError(): Error {
  return new Error('FileSource: file ended before the requested byte range was fully read.')
}

function asyncIterableToReadableStream(
  iterable: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done === true) {
        controller.close()
        return
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Async iterable content sources must yield Uint8Array chunks.')
      }
      controller.enqueue(value)
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
   * `false` for forward-only sources (`StreamSource`, `AsyncIterableSource`)
   * — the engine must read sequentially, one `partSize` chunk at a time.
   * Callers that branch on this flag are expected to fall back to the
   * sequential path rather than call `slice()` and catch the throw.
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
  toArrayBuffer(options: { readonly signal?: AbortSignal } = {}): Promise<ArrayBuffer> {
    options.signal?.throwIfAborted()
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
 * `FileSource` is Node-only but safe to import in browser builds: it touches
 * Node filesystem APIs only when constructed or read. Slices preserve the same
 * path with an adjusted byte range, so multipart uploads can read disjoint file
 * ranges without materialising the whole file in memory.
 */
export class FileSource implements ContentSource {
  /** Filesystem path backing this source. */
  readonly path: FileSourcePath
  /** Absolute byte offset in the file where this source starts. */
  readonly offset: number
  /** {@inheritDoc} */
  readonly size: number
  /** Random-access: file ranges are read by absolute byte offset. */
  readonly canSlice = true

  /**
   * Create a FileSource for a local file path.
   * @param path - Local filesystem path or file URL.
   * @param options - Optional offset/size range override.
   *
   * @throws If the runtime has no Node-compatible filesystem API.
   * @throws If the path does not reference a regular file when `size` is omitted.
   */
  constructor(path: FileSourcePath, options: FileSourceOptions = {}) {
    const offset = options.offset ?? 0
    validateByteCount('FileSource offset', offset)

    let size: number
    if (options.size !== undefined) {
      size = options.size
      validateByteCount('FileSource size', size)
    } else {
      const stat = getNodeFsSync().statSync(path)
      if (!stat.isFile()) throw new Error('FileSource path must reference a regular file.')
      size = Math.max(stat.size - offset, 0)
    }

    this.path = path
    this.offset = offset
    this.size = size
  }

  /**
   * Return a new FileSource covering the specified byte range.
   * @param start - The zero-based byte offset to begin the slice.
   * @param end - The exclusive byte offset where the slice ends.
   *
   * @returns A new ContentSource representing the requested sub-range.
   */
  slice(start: number, end: number): ContentSource {
    const normalizedStart = normalizeSliceOffset(start, this.size)
    const normalizedEnd = normalizeSliceOffset(end, this.size)
    return new FileSource(this.path, {
      offset: this.offset + normalizedStart,
      size: Math.max(normalizedEnd - normalizedStart, 0),
    })
  }

  /**
   * Open this file range as a Web ReadableStream.
   * @returns A ReadableStream that reads the configured file range lazily.
   */
  stream(): ReadableStream<Uint8Array> {
    const path = this.path
    let position = this.offset
    let remaining = this.size
    let file: NodeFileHandle | undefined

    const closeFile = async (): Promise<void> => {
      if (file === undefined) return
      const current = file
      file = undefined
      await current.close()
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (remaining === 0) {
            await closeFile()
            controller.close()
            return
          }

          file ??= await openNodeFile(path)
          const buffer = new Uint8Array(Math.min(FILE_READ_CHUNK_SIZE, remaining))
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position)
          if (bytesRead === 0) throw rangeEndedEarlyError()

          position += bytesRead
          remaining -= bytesRead
          controller.enqueue(
            bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead),
          )

          if (remaining === 0) {
            await closeFile()
            controller.close()
          }
        } catch (err) {
          await closeFile().catch(() => {})
          throw err
        }
      },
      async cancel() {
        await closeFile()
      },
    })
  }

  /**
   * Read this file range into an ArrayBuffer.
   * @returns A promise resolving with exactly this source's byte range.
   */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    if (this.size === 0) return new ArrayBuffer(0)

    const file = await openNodeFile(this.path)
    const data = new Uint8Array(this.size)
    let filled = 0
    try {
      while (filled < data.byteLength) {
        const { bytesRead } = await file.read(
          data,
          filled,
          data.byteLength - filled,
          this.offset + filled,
        )
        if (bytesRead === 0) throw rangeEndedEarlyError()
        filled += bytesRead
      }
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    } finally {
      await file.close()
    }
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
export class AsyncIterableSource extends StreamSource {
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
  if (size === undefined) {
    throw new Error('size is required when using a forward-only content source as input.')
  }
  if (input instanceof ReadableStream) {
    return new StreamSource(input, size)
  }
  if (isAsyncIterable(input)) {
    return new AsyncIterableSource(input, size)
  }
  throw new TypeError('Unsupported content source input.')
}
