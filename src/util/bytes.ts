/**
 * Return an ArrayBuffer containing exactly the bytes visible through a
 * Uint8Array view.
 *
 * Exact `ArrayBuffer` views are returned directly. Subarray and
 * `SharedArrayBuffer`-backed views are copied with `Uint8Array.slice()` so Web
 * Crypto receives a plain `ArrayBuffer` containing only the visible bytes.
 *
 * @param bytes - The byte view to copy.
 *
 * @returns An ArrayBuffer containing exactly `bytes`.
 */
export function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }

  return bytes.slice().buffer as ArrayBuffer
}
