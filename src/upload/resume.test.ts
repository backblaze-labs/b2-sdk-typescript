import { describe, expect, it } from 'vitest'
import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { EncryptionAlgorithm, EncryptionMode } from '../types/encryption.ts'
import { bucketId, type LargeFileId } from '../types/ids.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'
import {
  findResumeCandidate,
  RESUME_PART_SIZE_INFO_KEY,
  RESUME_SOURCE_SIZE_INFO_KEY,
  type ResumeCandidateCriteria,
} from './resume.ts'

/**
 * Unit tests targeting `findResumeCandidate` decision branches. The
 * integration-style tests exercise the happy path against the simulator, while
 * these tests drive the function directly with mocked `RawClient` and
 * `AccountInfo` so we can pin rejection and pagination behavior.
 */

function makeAccountInfo(): AccountInfo {
  return {
    getApiUrl: () => 'http://mock:0',
    getAuthToken: () => 'mock-token',
  } as unknown as AccountInfo
}

function defaultResumeCriteria(
  overrides: Partial<ResumeCandidateCriteria> = {},
): ResumeCandidateCriteria {
  return {
    contentType: 'application/octet-stream',
    fileInfo: {},
    sourceSize: 200,
    partSize: 100,
    parts: [
      { partNumber: 1, length: 100 },
      { partNumber: 2, length: 100 },
    ],
    ...overrides,
  }
}

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

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      defaultResumeCriteria(),
    )
    expect(result).toBeNull()
  })

  it('returns null when listUnfinishedLargeFiles returns an empty list', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return { files: [], nextFileName: null, nextFileId: null }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'anything.bin',
      defaultResumeCriteria(),
    )
    expect(result).toBeNull()
  })

  it('returns the candidate with collected part SHA-1s when a match exists', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            { fileId: 'wrong-one', fileName: 'not-this.bin' },
            {
              fileId: 'lf-match',
              fileName: 'wanted.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
            },
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

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'wanted.bin',
      defaultResumeCriteria(),
    )
    expect(result).not.toBeNull()
    expect(result?.fileId).toBe('lf-match' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('p1')
    expect(result?.uploadedPartSha1s.get(2)).toBe('p2')
  })

  it('prefers the newest compatible same-name candidate', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'older-match',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'newer-match',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 2000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('newer-match')
        return {
          parts: [{ partNumber: 1, contentSha1: 'new-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('newer-match' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('new-p1')
  })

  it('prefers the later listed compatible candidate when timestamps tie', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'first-match',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'second-match',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('second-match')
        return {
          parts: [{ partNumber: 1, contentSha1: 'second-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('second-match' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('second-p1')
  })

  it('skips newer same-name candidates whose upload options do not match', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'older-compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'newer-conflict',
              fileName: 'target.bin',
              contentType: 'text/plain',
              fileInfo,
              uploadTimestamp: 2000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('older-compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'old-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result?.fileId).toBe('older-compatible' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('old-p1')
    expect(rejected).toEqual(['content-type-mismatch'])
  })

  it('rejects resolved content types for automatic b2/x-auto uploads', async () => {
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for automatic b2/x-auto mismatch')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'b2/x-auto',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['content-type-mismatch'])
  })

  it('accepts resolved content types for explicit b2/x-auto resumeFileId uploads', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'auto-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'b2/x-auto',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'compatible' as LargeFileId,
      },
    )

    expect(result?.fileId).toBe('compatible' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('auto-p1')
  })

  it('reports the candidate limit before listing more compatible candidates', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called after the candidate limit')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        maxPartCandidates: 0,
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['candidate-limit'])
  })

  it('compares caller fileInfo separately from legacy SDK resume metadata', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'legacy-match',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {
                ...fileInfo,
                [RESUME_SOURCE_SIZE_INFO_KEY]: '200',
                [RESUME_PART_SIZE_INFO_KEY]: '100',
              },
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'legacy-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('legacy-match' as LargeFileId)
  })

  it('rejects legacy SDK resume metadata size mismatches', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'wrong-part-size',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {
                ...fileInfo,
                [RESUME_PART_SIZE_INFO_KEY]: '99',
              },
              uploadTimestamp: 2000,
            },
            {
              fileId: 'wrong-source-size',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {
                ...fileInfo,
                [RESUME_SOURCE_SIZE_INFO_KEY]: '199',
              },
              uploadTimestamp: 3000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'legacy-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result?.fileId).toBe('compatible' as LargeFileId)
    expect(rejected).toEqual(['source-size-mismatch', 'part-size-mismatch'])
  })

  it('requires encryption, retention, and legal hold to match', async () => {
    const fileInfo = { owner: 'unit' }
    const expectedRetention = {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: 1_800_000_000_000,
    }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: {
                mode: EncryptionMode.SseB2,
                algorithm: EncryptionAlgorithm.Aes256,
              },
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: expectedRetention,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: LegalHoldValue.On,
              },
            },
            {
              fileId: 'wrong-encryption',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 2000,
              serverSideEncryption: {
                mode: EncryptionMode.SseC,
                algorithm: EncryptionAlgorithm.Aes256,
              },
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: expectedRetention,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: LegalHoldValue.On,
              },
            },
            {
              fileId: 'wrong-retention',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 3000,
              serverSideEncryption: {
                mode: EncryptionMode.SseB2,
                algorithm: EncryptionAlgorithm.Aes256,
              },
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: null,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: LegalHoldValue.On,
              },
            },
            {
              fileId: 'wrong-hold',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 4000,
              serverSideEncryption: {
                mode: EncryptionMode.SseB2,
                algorithm: EncryptionAlgorithm.Aes256,
              },
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: expectedRetention,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: LegalHoldValue.Off,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        serverSideEncryption: {
          mode: EncryptionMode.SseB2,
          algorithm: EncryptionAlgorithm.Aes256,
        },
        fileRetention: expectedRetention,
        legalHold: LegalHoldValue.On,
      },
    )

    expect(result?.fileId).toBe('compatible' as LargeFileId)
  })

  it('accepts unreadable retention and legal hold when the caller did not request them', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'restricted-object-lock',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              fileRetention: {
                isClientAuthorizedToRead: false,
                value: null,
              },
              legalHold: {
                isClientAuthorizedToRead: false,
                value: null,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('restricted-object-lock')
        return {
          parts: [{ partNumber: 1, contentSha1: 'restricted-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('restricted-object-lock' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('restricted-p1')
  })

  it('rejects unreadable retention and legal hold when the caller requested them', async () => {
    const fileInfo = { owner: 'unit' }
    const expectedRetention = {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: 1_800_000_000_000,
    }
    const rejected: Array<{ fileId: LargeFileId | undefined; reason: string }> = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'restricted-retention',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              fileRetention: {
                isClientAuthorizedToRead: false,
                value: null,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: LegalHoldValue.On,
              },
            },
            {
              fileId: 'restricted-legal-hold',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 2000,
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: expectedRetention,
              },
              legalHold: {
                isClientAuthorizedToRead: false,
                value: null,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for unreadable requested Object Lock state')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        fileRetention: expectedRetention,
        legalHold: LegalHoldValue.On,
        onCandidateRejected: (event) =>
          rejected.push({ fileId: event.fileId, reason: event.reason }),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(
      expect.arrayContaining([
        { fileId: 'restricted-retention' as LargeFileId, reason: 'retention-mismatch' },
        { fileId: 'restricted-legal-hold' as LargeFileId, reason: 'legal-hold-mismatch' },
      ]),
    )
  })

  it('rejects SSE-C candidates when no encryption option was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'sse-c-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: {
                mode: EncryptionMode.SseC,
                algorithm: EncryptionAlgorithm.Aes256,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for an encryption rejection')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['sse-c-unsupported'])
  })

  it('rejects SSE-C candidates from automatic discovery even with the same algorithm', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'sse-c-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: {
                mode: EncryptionMode.SseC,
                algorithm: EncryptionAlgorithm.Aes256,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for an SSE-C auto-resume rejection')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        serverSideEncryption: {
          mode: EncryptionMode.SseC,
          algorithm: EncryptionAlgorithm.Aes256,
          customerKey: 'victim-key',
          customerKeyMd5: 'victim-md5',
        },
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['sse-c-unsupported'])
  })

  it('accepts SSE-B2 candidates when no encryption option was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'sse-b2-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: {
                mode: EncryptionMode.SseB2,
                algorithm: EncryptionAlgorithm.Aes256,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('sse-b2-candidate' as LargeFileId)
  })

  it('accepts an explicit none-encryption candidate when none was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'none-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: { mode: EncryptionMode.None },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        serverSideEncryption: { mode: EncryptionMode.None },
      },
    )

    expect(result?.fileId).toBe('none-candidate' as LargeFileId)
  })

  it('accepts missing encryption metadata when explicit no encryption was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'implicit-none-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        serverSideEncryption: { mode: EncryptionMode.None },
      },
    )

    expect(result?.fileId).toBe('implicit-none-candidate' as LargeFileId)
  })

  it('accepts the B2 null no-encryption wire shape when none was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'null-none-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: { mode: null, algorithm: null },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(result?.fileId).toBe('null-none-candidate' as LargeFileId)
  })

  it('rejects missing encryption metadata when encryption was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'plain-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for missing encryption metadata')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        serverSideEncryption: {
          mode: EncryptionMode.SseB2,
          algorithm: EncryptionAlgorithm.Aes256,
        },
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['encryption-mismatch'])
  })

  it('rejects explicit SSE-C resumeFileId candidates before listing parts', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'sse-c-candidate',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
              serverSideEncryption: {
                mode: EncryptionMode.SseC,
                algorithm: 'AES512',
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for an SSE-C algorithm mismatch')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'sse-c-candidate' as LargeFileId,
        serverSideEncryption: {
          mode: EncryptionMode.SseC,
          algorithm: EncryptionAlgorithm.Aes256,
          customerKey: 'key',
          customerKeyMd5: 'md5',
        },
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual(['sse-c-unsupported'])
  })

  it('rejects present but unrecognized encryption when none was requested', async () => {
    const fileInfo = { owner: 'unit' }
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'unknown-encryption',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 2000,
              serverSideEncryption: { mode: 'SSE-FUTURE', algorithm: 'AES512' },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result?.fileId).toBe('compatible' as LargeFileId)
    expect(rejected).toEqual(['encryption-mismatch'])
  })

  it('skips same-name candidates whose uploaded part lengths do not match the local plan', async () => {
    const fileInfo = { owner: 'unit' }
    const seen: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 1000,
            },
            {
              fileId: 'wrong-part-size',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo,
              uploadTimestamp: 2000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        seen.push(req.fileId)
        if (req.fileId === 'wrong-part-size') {
          return {
            parts: [{ partNumber: 1, contentSha1: 'bad-p1', contentLength: 50 }],
            nextPartNumber: null,
          }
        }
        return {
          parts: [{ partNumber: 1, contentSha1: 'good-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo,
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
      },
    )

    expect(seen).toEqual(['wrong-part-size', 'compatible'])
    expect(result?.fileId).toBe('compatible' as LargeFileId)
  })

  it('bounds unfinished-file pagination and reports truncation', async () => {
    let calls = 0
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        calls++
        return {
          files: [],
          nextFileId: `next-${calls}`,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        maxListPages: 2,
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(calls).toBe(2)
    expect(rejected).toEqual(['search-truncated'])
  })

  it('uses the best scanned candidate when later pages are truncated away', async () => {
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'older-compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: 'newer-compatible',
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'older-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        maxListPages: 1,
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result?.fileId).toBe('older-compatible' as LargeFileId)
    expect(result?.uploadedPartSha1s.get(1)).toBe('older-p1')
    expect(rejected).toEqual(['search-truncated'])
  })

  it('bounds same-prefix junk scans and reports truncation', async () => {
    let calls = 0
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        calls++
        return {
          files: Array.from({ length: 100 }, (_, index) => ({
            fileId: `junk-${calls}-${index}`,
            fileName: `target.bin.${calls}.${index}`,
          })),
          nextFileId: `next-${calls}`,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for same-prefix junk')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        maxListPages: 3,
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(calls).toBe(3)
    expect(rejected).toEqual(['search-truncated'])
  })

  it('passes the abort signal to discovery list requests and part listings', async () => {
    const controller = new AbortController()
    let listSignal: AbortSignal | undefined
    let partSignal: AbortSignal | undefined
    const raw = {
      async listUnfinishedLargeFiles(
        _apiUrl: string,
        _authToken: string,
        _req: unknown,
        options?: { signal?: AbortSignal },
      ) {
        listSignal = options?.signal
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(
        _apiUrl: string,
        _authToken: string,
        _req: unknown,
        options?: { signal?: AbortSignal },
      ) {
        partSignal = options?.signal
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        signal: controller.signal,
      },
    )

    expect(result?.fileId).toBe('target-id' as LargeFileId)
    expect(listSignal).toBe(controller.signal)
    expect(partSignal).toBe(controller.signal)
  })

  it('honors an abort signal between listParts pages', async () => {
    const controller = new AbortController()
    let listPartCalls = 0
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        listPartCalls++
        controller.abort()
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: 2,
        }
      },
    } as unknown as RawClient

    await expect(
      findResumeCandidate(raw, makeAccountInfo(), bucketId('bucket1'), 'target.bin', {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(listPartCalls).toBe(1)
  })

  it('bounds part listing for candidates with more parts than the local plan', async () => {
    const listPartRequests: Array<{ maxPartCount?: number; startPartNumber?: number }> = []
    const rejected: string[] = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'too-many-parts',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(
        _apiUrl: string,
        _authToken: string,
        req: { maxPartCount?: number; startPartNumber?: number },
      ) {
        listPartRequests.push({
          ...(req.maxPartCount !== undefined ? { maxPartCount: req.maxPartCount } : {}),
          ...(req.startPartNumber !== undefined ? { startPartNumber: req.startPartNumber } : {}),
        })
        return {
          parts: [
            { partNumber: 1, contentSha1: 'p1', contentLength: 100 },
            { partNumber: 2, contentSha1: 'p2', contentLength: 100 },
            { partNumber: 3, contentSha1: 'p3', contentLength: 100 },
          ],
          nextPartNumber: 4,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: (event) => rejected.push(event.reason),
      },
    )

    expect(result).toBeNull()
    expect(listPartRequests).toEqual([{ maxPartCount: 3 }])
    expect(rejected).toEqual(['part-length-mismatch'])
  })

  it('continues resume discovery when a diagnostic callback throws', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'wrong-info',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: { owner: 'other' },
              uploadTimestamp: 2000,
            },
            {
              fileId: 'compatible',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('compatible')
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        onCandidateRejected: () => {
          throw new Error('diagnostic sink failed')
        },
      },
    )

    expect(result?.fileId).toBe('compatible' as LargeFileId)
  })

  it('jumps directly to an explicit resumeFileId with the inclusive cursor', async () => {
    const listCalls: Array<{ maxFileCount?: number; namePrefix?: string; startFileId?: string }> =
      []
    const raw = {
      async listUnfinishedLargeFiles(
        _apiUrl: string,
        _authToken: string,
        req: { maxFileCount?: number; namePrefix?: string; startFileId?: string },
      ) {
        listCalls.push(req)
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: 'next-id',
        }
      },
      async listParts(_apiUrl: string, _authToken: string, req: { fileId: string }) {
        expect(req.fileId).toBe('target-id')
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'target-id' as LargeFileId,
      },
    )

    expect(result?.fileId).toBe('target-id' as LargeFileId)
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]).toMatchObject({
      maxFileCount: 1,
      startFileId: 'target-id',
    })
    expect(listCalls[0]).toMatchObject({
      namePrefix: 'target.bin',
    })
  })

  it('accepts an explicit resumeFileId with unreadable omitted retention state', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
              fileRetention: {
                isClientAuthorizedToRead: false,
                value: null,
              },
              legalHold: {
                isClientAuthorizedToRead: true,
                value: null,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'target-id' as LargeFileId,
      },
    )

    expect(result?.fileId).toBe('target-id' as LargeFileId)
  })

  it('accepts an explicit resumeFileId with unreadable omitted legal-hold state', async () => {
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'target.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
              fileRetention: {
                isClientAuthorizedToRead: true,
                value: null,
              },
              legalHold: {
                isClientAuthorizedToRead: false,
                value: null,
              },
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        return {
          parts: [{ partNumber: 1, contentSha1: 'target-p1', contentLength: 100 }],
          nextPartNumber: null,
        }
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'target.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'target-id' as LargeFileId,
      },
    )

    expect(result?.fileId).toBe('target-id' as LargeFileId)
  })

  it('reports requested and candidate names when an explicit resumeFileId is rejected', async () => {
    const rejected: Array<{
      fileId?: LargeFileId
      requestedFileName: string
      candidateFileName?: string
      reason: string
    }> = []
    const raw = {
      async listUnfinishedLargeFiles() {
        return {
          files: [
            {
              fileId: 'target-id',
              fileName: 'foreign.bin',
              contentType: 'application/octet-stream',
              fileInfo: {},
              uploadTimestamp: 1000,
            },
          ],
          nextFileId: null,
        }
      },
      async listParts() {
        throw new Error('listParts should not be called for a metadata rejection')
      },
    } as unknown as RawClient

    const result = await findResumeCandidate(
      raw,
      makeAccountInfo(),
      bucketId('bucket1'),
      'wanted.bin',
      {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        resumeFileId: 'target-id' as LargeFileId,
        onCandidateRejected: (event) => rejected.push(event),
      },
    )

    expect(result).toBeNull()
    expect(rejected).toEqual([
      {
        fileId: 'target-id' as LargeFileId,
        requestedFileName: 'wanted.bin',
        candidateFileName: 'foreign.bin',
        reason: 'file-name-mismatch',
      },
    ])
  })

  it('honors an abort signal before discovery list calls', async () => {
    const controller = new AbortController()
    controller.abort()
    const raw = {
      async listUnfinishedLargeFiles() {
        throw new Error('listUnfinishedLargeFiles should not be called')
      },
    } as unknown as RawClient

    await expect(
      findResumeCandidate(raw, makeAccountInfo(), bucketId('bucket1'), 'target.bin', {
        contentType: 'application/octet-stream',
        fileInfo: {},
        sourceSize: 200,
        partSize: 100,
        parts: [
          { partNumber: 1, length: 100 },
          { partNumber: 2, length: 100 },
        ],
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })
})
