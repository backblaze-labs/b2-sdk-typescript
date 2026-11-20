import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { fileId } from '../types/ids.ts'
import { createParallelDownloadStream } from './parallel.ts'

describe('parallel range validation cleanup', () => {
  it('does not retain caller abort listeners after rejecting invalid ranges', async () => {
    const controller = new AbortController()
    const downloadFileById = vi.fn()
    const raw = { downloadFileById } as unknown as RawClient
    const streams: ReadableStream<Uint8Array>[] = []
    const errors: unknown[] = []
    const baseline = getEventListeners(controller.signal, 'abort').length
    const counts = [baseline]

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          streams.push(
            createParallelDownloadStream(raw, {} as AccountInfo, {
              fileId: fileId('invalid-range'),
              totalSize: 25,
              rangeSize: 0,
              signal: controller.signal,
            }),
          )
        } catch (error) {
          errors.push(error)
        }
        counts.push(getEventListeners(controller.signal, 'abort').length)
      }

      expect(errors).toHaveLength(3)
      for (const error of errors) expect(error).toBeInstanceOf(RangeError)
      expect(counts, 'abort listeners accumulated across invalid range calls').toEqual([
        baseline,
        baseline,
        baseline,
        baseline,
      ])
      expect(downloadFileById).not.toHaveBeenCalled()
    } finally {
      await Promise.all(streams.map((stream) => stream.cancel()))
      controller.abort()
    }
  })
})
