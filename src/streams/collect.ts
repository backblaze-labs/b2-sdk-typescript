/**
 * Drain a `ReadableStream<Uint8Array>` into a single contiguous
 * `Uint8Array`. Releases the reader lock on both the happy and error
 * paths so the underlying stream can propagate close / error events to
 * the upstream producer.
 *
 * Used by both `createParallelDownloadStream` (per-range fetch) and
 * `StreamSource.toArrayBuffer` (whole-source materialisation). The two
 * code paths previously hand-rolled the same accumulate-then-concat
 * loop; consolidating here removes ~25 duplicated lines and a class of
 * lock-leak bugs.
 *
 * @param stream - Readable stream to consume. Will be fully drained.
 *
 * @returns A new `Uint8Array` containing every byte the stream produced.
 */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
    const result = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  } finally {
    // Releasing here lets the underlying stream propagate close / error
    // events to any upstream producer (e.g. a Node `Readable`) even on
    // the error path where a mid-read throw left the reader locked.
    reader.releaseLock()
  }
}
