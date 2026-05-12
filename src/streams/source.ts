export interface ContentSource {
  readonly size: number
  readonly sha1?: string
  slice(start: number, end: number): ContentSource
  stream(): ReadableStream<Uint8Array>
  toArrayBuffer(): Promise<ArrayBuffer>
}

export class BlobSource implements ContentSource {
  readonly size: number

  constructor(private readonly blob: Blob) {
    this.size = blob.size
  }

  slice(start: number, end: number): ContentSource {
    return new BlobSource(this.blob.slice(start, end))
  }

  stream(): ReadableStream<Uint8Array> {
    return this.blob.stream() as ReadableStream<Uint8Array>
  }

  toArrayBuffer(): Promise<ArrayBuffer> {
    return this.blob.arrayBuffer()
  }
}

export class BufferSource implements ContentSource {
  readonly size: number

  constructor(private readonly buffer: Uint8Array) {
    this.size = buffer.byteLength
  }

  slice(start: number, end: number): ContentSource {
    return new BufferSource(this.buffer.slice(start, end))
  }

  stream(): ReadableStream<Uint8Array> {
    const buffer = this.buffer
    return new ReadableStream({
      start(controller) {
        controller.enqueue(buffer)
        controller.close()
      },
    })
  }

  toArrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(
      this.buffer.buffer.slice(
        this.buffer.byteOffset,
        this.buffer.byteOffset + this.buffer.byteLength,
      ) as ArrayBuffer,
    )
  }
}

export class StreamSource implements ContentSource {
  readonly size: number
  private consumed = false

  constructor(
    private readonly readable: ReadableStream<Uint8Array>,
    size: number,
  ) {
    this.size = size
  }

  slice(): ContentSource {
    throw new Error('StreamSource does not support slicing. Buffer the stream first.')
  }

  stream(): ReadableStream<Uint8Array> {
    if (this.consumed) throw new Error('StreamSource can only be consumed once.')
    this.consumed = true
    return this.readable
  }

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
