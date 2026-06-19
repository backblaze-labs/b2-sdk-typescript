/**
 * Return an ArrayBuffer containing exactly the bytes visible through a
 * Uint8Array view.
 *
 * The explicit `slice(byteOffset, byteOffset + byteLength)` defends against a
 * Uint8Array view that points at a subset of a larger buffer. Casting to
 * `ArrayBuffer` is needed because TypeScript types Uint8Array's buffer as
 * `ArrayBufferLike`, which includes `SharedArrayBuffer`. Web Crypto APIs only
 * accept the plain `ArrayBuffer` variant.
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
