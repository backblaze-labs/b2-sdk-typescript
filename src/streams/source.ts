import { arrayBufferFor } from '../util/bytes.ts'

export { FileSource, type FileSourcePath } from './file-source.ts'

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
        await returnAsyncIteratorBestEffort(iterator)
        throw err
      }
    },
    async cancel(reason) {
      await returnAsyncIteratorBestEffort(iterator, reason)
    },
  })
}

async function returnAsyncIteratorBestEffort(
  iterator: AsyncIterator<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  try {
    await iterator.return?.(reason)
  } catch {
    // Iterator cleanup is secondary and must not mask the pull error.
  }
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

/**
 * Reads exactly the advertised number of bytes from a stream.
 * @param stream - Stream to consume.
 * @param expectedSize - Exact number of bytes expected from the stream.
 * @param signal - Optional abort signal for cancelling the read.
 *
 * @returns A byte array of length `expectedSize`.
 *
 * @throws If the stream emits too few bytes, too many bytes, too many empty chunks, or aborts.
 */
export async function collectStreamExactly(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let completed = false

  try {
    while (total < expectedSize) {
      const { done, value } = await readNextNonEmptyStreamChunk(
        reader,
        STREAM_SOURCE_TOO_MANY_EMPTY_CHUNKS_ERROR,
        signal,
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
      signal,
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
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      void reader.cancel(signal.reason).catch(() => {})
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
