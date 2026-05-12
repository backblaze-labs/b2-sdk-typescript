/**
 * Uniform adapter for upload content. Wraps File, Blob, Buffer, or ReadableStream
 * behind a common interface so upload logic does not depend on the input type.
 */
export interface ContentSource {
  /** Total size of the content in bytes. */
  readonly size: number
  /** Pre-computed SHA-1 hex digest, if available. */
  readonly sha1?: string
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

  /** Create a BlobSource wrapping the given Blob. */
  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }

  /** {@inheritDoc} */
  slice(start: number, end: number): ContentSource {
    return new BlobSource(this.blob.slice(start, end))
  }

  /** {@inheritDoc} */
  stream(): ReadableStream<Uint8Array> {
    return this.blob.stream() as ReadableStream<Uint8Array>
  }

  /** {@inheritDoc} */
  toArrayBuffer(): Promise<ArrayBuffer> {
    return this.blob.arrayBuffer()
  }
}

/** ContentSource backed by a Uint8Array buffer. */
export class BufferSource implements ContentSource {
  /** {@inheritDoc} */
  readonly size: number

  /** Create a BufferSource wrapping the given Uint8Array. */
  constructor(private readonly buffer: Uint8Array) {
    this.size = buffer.byteLength
  }

  /** {@inheritDoc} */
  slice(start: number, end: number): ContentSource {
    return new BufferSource(this.buffer.slice(start, end))
  }

  /** {@inheritDoc} */
  stream(): ReadableStream<Uint8Array> {
    const buffer = this.buffer
    return new ReadableStream({
      start(controller) {
        controller.enqueue(buffer)
        controller.close()
      },
    })
  }

  /** {@inheritDoc} */
  toArrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.buffer.buffer.slice(
        this.buffer.byteOffset,
        this.buffer.byteOffset + this.buffer.byteLength,
      ) as ArrayBuffer,
    )
  }
}

/** ContentSource backed by a ReadableStream. Can only be consumed once and does not support slicing. */
export class StreamSource implements ContentSource {
  /** {@inheritDoc} */
  readonly size: number
  /** Whether the stream has already been read. */
  private consumed = false

  /** Create a StreamSource wrapping the given ReadableStream with a known byte size. */
  constructor(
    private readonly readable: ReadableStream<Uint8Array>,
    size: number,
  ) {
    this.size = size
  }

  /** Always throws because streams cannot be sliced. Buffer the stream first. */
  slice(): ContentSource {
    throw new Error('StreamSource does not support slicing. Buffer the stream first.')
  }

  /** Opens the stream. Throws if called more than once. */
  stream(): ReadableStream<Uint8Array> {
    if (this.consumed) throw new Error('StreamSource can only be consumed once.')
    this.consumed = true
    return this.readable
  }

  /** {@inheritDoc} */
  async toArrayBuffer(): Promise<ArrayBuffer> {
    const reader = this.stream().getReader()
    const chunks: Uint8Array[] = []
    let totalLen = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      totalLen += value.byteLength
    }
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result.buffer
  }
}

/**
 * Convert a Uint8Array, Blob, or ReadableStream into a {@link ContentSource}.
 * When passing a ReadableStream, the `size` parameter is required.
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
