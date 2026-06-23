import { describe, expect, it } from 'vitest'

import { arrayBufferFor } from './bytes.ts'

describe('arrayBufferFor', () => {
  it('returns the same ArrayBuffer when the view spans it exactly', () => {
    const bytes = new Uint8Array([1, 2, 3])

    expect(arrayBufferFor(bytes)).toBe(bytes.buffer)
  })

  it('copies subarray views into an exact ArrayBuffer', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3)
    const buffer = arrayBufferFor(bytes)

    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(buffer)]).toEqual([2, 3])
  })

  it.skipIf(typeof Buffer === 'undefined')(
    'copies Buffer views without exposing slab bytes',
    () => {
      const slab = Buffer.allocUnsafe(16)
      slab.fill(0)
      slab.set([1, 2, 3], 5)
      const bytes = slab.subarray(5, 8)
      const buffer = arrayBufferFor(bytes)

      expect(buffer).toBeInstanceOf(ArrayBuffer)
      expect(buffer.byteLength).toBe(bytes.byteLength)
      expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3])
    },
  )

  it.skipIf(typeof SharedArrayBuffer === 'undefined')(
    'copies SharedArrayBuffer-backed views into an ArrayBuffer',
    () => {
      const shared = new SharedArrayBuffer(4)
      const bytes = new Uint8Array(shared)
      bytes.set([1, 2, 3, 4])
      const buffer = arrayBufferFor(bytes.subarray(1, 3))

      expect(buffer).toBeInstanceOf(ArrayBuffer)
      expect(buffer).not.toBe(shared)
      expect([...new Uint8Array(buffer)]).toEqual([2, 3])
    },
  )
})
