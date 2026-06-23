/**
 * Return an ArrayBuffer containing exactly the bytes visible through a
 * Uint8Array view.
 *
 * Exact `ArrayBuffer` views are returned directly. Other `ArrayBuffer` views
 * are copied with `ArrayBuffer.prototype.slice()` so Node `Buffer` instances do
 * not expose slab bytes. `SharedArrayBuffer`-backed views are copied through a
 * fresh `Uint8Array` so Web Crypto receives a plain `ArrayBuffer`.
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
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  return new Uint8Array(bytes).buffer
}
