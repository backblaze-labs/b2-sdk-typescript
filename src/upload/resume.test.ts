import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { LargeFileId } from '../types/ids.ts'
import { collectPartSha1s, findResumeCandidate } from './resume.ts'

/**
 * Unit tests targeting `collectPartSha1s` pagination and `findResumeCandidate`
 * decision branches. The integration-style tests in `upload.test.ts` exercise
 * the happy path against the simulator but never produce enough parts to push
 * a multi-page `listParts` response, leaving the pagination loop uncovered.
 * These tests drive the functions directly with mocked `RawClient` /
 * `AccountInfo` so we can pin the continuation logic.
 */

function makeAccountInfo(): AccountInfo {
  return {
    getApiUrl: () => 'http://mock:0',
    getAuthToken: () => 'mock-token',
  } as unknown as AccountInfo
}

describe('collectPartSha1s', () => {
  it('returns an empty map when listParts has no entries and no next page', async () => {
    const calls: Array<{ fileId: string; startPartNumber?: number }> = []
    const raw = {
      async listParts(
        _apiUrl: string,
        _authToken: string,
        req: { fileId: string; startPartNumber?: number },
      ) {
        calls.push({
          fileId: req.fileId,
          ...(req.startPartNumber !== undefined ? { startPartNumber: req.startPartNumber } : {}),
        })
        return { parts: [], nextPartNumber: null }
      },
    } as unknown as RawClient

    const result = await collectPartSha1s(raw, makeAccountInfo(), 'lf1' as LargeFileId)
    expect(result.size).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ fileId: 'lf1' })
  })

  it('paginates through listParts when nextPartNumber is non-null', async () => {
    const calls: Array<{ startPartNumber?: number }> = []
    const raw = {
      async listParts(
        _apiUrl: string,
        _authToken: string,
        req: { fileId: string; startPartNumber?: number },
      ) {
        calls.push({
          ...(req.startPartNumber !== undefined ? { startPartNumber: req.startPartNumber } : {}),
        })
        if (req.startPartNumber === undefined) {
          // First page: parts 1, 2; more available starting at 3.
          return {
            parts: [
              { partNumber: 1, contentSha1: 'sha1-1', contentLength: 100 },
              { partNumber: 2, contentSha1: 'sha1-2', contentLength: 100 },
            ],
            nextPartNumber: 3,
          }
        }
        // Second page: parts 3, 4; end of listing.
        return {
          parts: [
            { partNumber: 3, contentSha1: 'sha1-3', contentLength: 100 },
            { partNumber: 4, contentSha1: 'sha1-4', contentLength: 100 },
          ],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await collectPartSha1s(raw, makeAccountInfo(), 'lf2' as LargeFileId)
    expect(result.size).toBe(4)
    expect(result.get(1)).toBe('sha1-1')
    expect(result.get(2)).toBe('sha1-2')
    expect(result.get(3)).toBe('sha1-3')
    expect(result.get(4)).toBe('sha1-4')

    // Two paginated calls: first without a cursor, second with startPartNumber=3.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({})
    expect(calls[1]).toEqual({ startPartNumber: 3 })
  })

  it('handles three pages of parts (proves the loop terminates on null)', async () => {
    let invocation = 0
    const raw = {
      async listParts() {
        invocation++
        if (invocation === 1) {
          return {
            parts: [{ partNumber: 1, contentSha1: 's1', contentLength: 1 }],
            nextPartNumber: 2,
          }
        }
        if (invocation === 2) {
          return {
            parts: [{ partNumber: 2, contentSha1: 's2', contentLength: 1 }],
            nextPartNumber: 3,
          }
        }
        return {
          parts: [{ partNumber: 3, contentSha1: 's3', contentLength: 1 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await collectPartSha1s(raw, makeAccountInfo(), 'lf3' as LargeFileId)
    expect(result.size).toBe(3)
    expect(invocation).toBe(3)
  })
})

describe('findResumeCandidate', () => {
  it('returns null when no unfinished file matches the destination name', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [{ fileId: 'other', fileName: 'different.bin' }],
          nextFileName: null,
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called when no match exists')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(raw, makeAccountInfo(), 'bucket1', 'target.bin')
    expect(result).toBeNull()
  })

  it('returns null when listUnfinishedLargeFiles returns an empty list', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileName: null, nextFileId: null }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(raw, makeAccountInfo(), 'bucket1', 'anything.bin')
    expect(result).toBeNull()
  })

  it('returns the candidate with collected part SHA-1s when a match exists', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            { fileId: 'wrong-one', fileName: 'not-this.bin' },
            { fileId: 'lf-match', fileName: 'wanted.bin' },
          ],
          nextFileName: null,
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('lf-match')
        return {
          parts: [
            { partNumber: 1, contentSha1: 'p1', contentLength: 100 },
            { partNumber: 2, contentSha1: 'p2', contentLength: 100 },
          ],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(raw, makeAccountInfo(), 'bucket1', 'wanted.bin')
    expect(result).not.toBeNull()
    expect(result?.fileId).toBe('lf-match' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('p1')
    expect(result?.uploadedPartSha1s.get(2)).toBe('p2')
  })
})
