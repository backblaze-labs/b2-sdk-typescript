import type { AccountInfo } from '../auth/account-info.ts'
import { ResumeFileIdMismatchError } from '../errors/index.ts'
import type { RawClient } from '../raw/index.ts'
import { BucketRetentionMode, type BucketRetentionPolicy } from '../types/bucket.ts'
import {
  EncryptionMode,
  type EncryptionSetting,
  type PublicEncryptionSetting,
} from '../types/encryption.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { largeFileId as largeFileIdOf } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import type {
  ReadableFileRetention,
  ReadableLegalHold,
  UnfinishedLargeFile,
} from '../types/upload.ts'

export { ResumeFileIdMismatchError }

/** Compatibility-only file-info key read from legacy unfinished uploads; new uploads do not write it. */
export const RESUME_SOURCE_SIZE_INFO_KEY = 'b2_sdk_resume_source_size'

/** Compatibility-only file-info key read from legacy unfinished uploads; new uploads do not write it. */
export const RESUME_PART_SIZE_INFO_KEY = 'b2_sdk_resume_part_size'

const DEFAULT_MAX_RESUME_LIST_PAGES = 10
const DEFAULT_MAX_RESUME_PART_CANDIDATES = 25
const DEFAULT_MAX_RESUME_PART_PAGES = 10

/** One planned part from the local upload source. */
export interface ResumePartPlan {
  /** 1-based B2 part number. */
  readonly partNumber: number
  /** Expected byte length for this part. */
  readonly length: number
}

/** Reason an unfinished same-name large file was not reused for resume. */
export type ResumeCandidateRejectedReason =
  | 'search-truncated'
  | 'candidate-limit'
  | 'file-name-mismatch'
  | 'content-type-mismatch'
  | 'file-info-mismatch'
  | 'source-size-mismatch'
  | 'part-size-mismatch'
  | 'encryption-mismatch'
  | 'sse-c-unsupported'
  | 'retention-mismatch'
  | 'legal-hold-mismatch'
  | 'part-length-mismatch'

/** Diagnostic event emitted when resume discovery declines a candidate. */
export interface ResumeCandidateRejectedEvent {
  /** ID of the unfinished large file, when the event is candidate-specific. */
  readonly fileId?: LargeFileId
  /** Requested destination file name. */
  readonly requestedFileName: string
  /** Actual candidate file name, when the event is candidate-specific. */
  readonly candidateFileName?: string
  /** Machine-readable rejection reason. */
  readonly reason: ResumeCandidateRejectedReason
}

/** Diagnostic callback for declined resume candidates. */
export type ResumeCandidateRejectedListener = (event: ResumeCandidateRejectedEvent) => void

/** Compatibility requirements an unfinished large file must satisfy before reuse. */
export interface ResumeCandidateCriteria {
  /** Effective MIME type for the upload, including SDK defaults. */
  readonly contentType: string
  /** Caller-owned file info. Legacy SDK resume keys on candidates are ignored separately. */
  readonly fileInfo: Record<string, string>
  /** Source size in bytes, checked against legacy SDK metadata when a candidate carries it. */
  readonly sourceSize: number
  /** Effective multipart part size, checked against legacy SDK metadata when present. */
  readonly partSize: number
  /** Planned local parts used to verify already-uploaded server part lengths. */
  readonly parts: readonly ResumePartPlan[]
  /** Explicit server-side encryption option, if configured by the caller. */
  readonly serverSideEncryption?: EncryptionSetting
  /** Explicit Object Lock retention option, if configured by the caller. */
  readonly fileRetention?: FileRetentionValue
  /** Effective readable bucket default retention when the caller omits fileRetention. */
  readonly defaultFileRetention?: BucketRetentionPolicy
  /** Whether bucket default retention exists but cannot be read by the caller. */
  readonly defaultFileRetentionUnreadable?: boolean
  /** Explicit legal hold option, if configured by the caller. */
  readonly legalHold?: LegalHoldValue
  /** Explicit unfinished large-file ID to verify before reuse. */
  readonly resumeFileId?: LargeFileId
  /** Abort signal used for B2 list requests and checked between pages. */
  readonly signal?: AbortSignal
  /** Optional diagnostic callback for candidates that are found but not reused. */
  readonly onCandidateRejected?: ResumeCandidateRejectedListener
  /** Maximum `b2_list_unfinished_large_files` pages to inspect. */
  readonly maxListPages?: number
  /** Maximum metadata-compatible candidates whose parts may be listed. */
  readonly maxPartCandidates?: number
  /** Maximum `b2_list_parts` pages to inspect for each metadata-compatible candidate. */
  readonly maxPartPages?: number
  /** Caller-supplied aggregate resume discovery timeout. */
  readonly discoveryTimeoutMs?: number
}

/** Uploaded part metadata used by the resume planner. */
export interface ResumePartInfo {
  /** SHA-1 stored by B2 for this uploaded part. */
  readonly contentSha1: string
  /** Byte length stored by B2 for this uploaded part. */
  readonly contentLength: number
}

const RESUME_DISCOVERY_PAGE_SIZE = 100
const MAX_RESUME_DISCOVERY_PAGES = 10

/** Information about an unfinished large file eligible for resume. */
export interface ResumeCandidate {
  /** ID of the unfinished large file. */
  readonly fileId: LargeFileId
  /** SHA-1 of each part already uploaded, indexed by 1-based part number. */
  readonly uploadedPartSha1s: ReadonlyMap<number, string>
}

/**
 * Finds an unfinished large file matching the given bucket and file name.
 * Returns `null` when no compatible candidate exists.
 *
 * With criteria, the newest compatible candidate is selected; incompatible
 * same-name uploads are ignored and optionally reported via
 * `onCandidateRejected`.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Target bucket of the upload.
 * @param fileName - Destination file name of the upload.
 * @param criteria - Upload identity and option checks.
 *
 * @returns A {@link ResumeCandidate} describing the candidate and its uploaded parts, or `null`.
 */
export async function findResumeCandidate(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
  fileName: string,
  criteria: ResumeCandidateCriteria,
): Promise<ResumeCandidate | null> {
  const discoverySignal = createResumeDiscoverySignal(criteria)
  try {
    return await findResumeCandidateWithSignal(
      raw,
      accountInfo,
      bucketId,
      fileName,
      criteria,
      discoverySignal.signal,
    )
  } finally {
    discoverySignal.dispose()
  }
}

async function findResumeCandidateWithSignal(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
  fileName: string,
  criteria: ResumeCandidateCriteria,
  signal: AbortSignal | undefined,
): Promise<ResumeCandidate | null> {
  const matches: Array<{ file: UnfinishedLargeFile; sequence: number }> = []
  const maxListPages = criteria.maxListPages ?? DEFAULT_MAX_RESUME_LIST_PAGES
  const maxPartCandidates = criteria.maxPartCandidates ?? DEFAULT_MAX_RESUME_PART_CANDIDATES
  let sequence = 0
  let pageCount = 0
  const explicitResumeFileId = criteria.resumeFileId
  let startFileId: LargeFileId | undefined = explicitResumeFileId
  let truncated = false

  while (pageCount < maxListPages) {
    signal?.throwIfAborted()
    const unfinished = await abortableRequest(
      raw.listUnfinishedLargeFiles(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        {
          bucketId,
          maxFileCount: explicitResumeFileId !== undefined ? 1 : 100,
          namePrefix: fileName,
          ...(startFileId !== undefined ? { startFileId } : {}),
        },
        signal !== undefined ? { signal } : undefined,
      ),
      signal,
    )
    pageCount++

    for (const file of unfinished.files) {
      const isMatch =
        explicitResumeFileId !== undefined
          ? file.fileId === explicitResumeFileId
          : file.fileName === fileName
      if (isMatch) {
        matches.push({ file, sequence })
      }
      sequence++
    }

    if (explicitResumeFileId !== undefined) break
    if (unfinished.nextFileId === null) break
    startFileId = unfinished.nextFileId
    truncated = pageCount >= maxListPages
  }

  if (truncated) {
    emitCandidateRejected(criteria, {
      requestedFileName: fileName,
      reason: 'search-truncated',
    })
  }

  matches.sort(compareNewestFirst)

  let partCandidatesInspected = 0
  for (const match of matches) {
    signal?.throwIfAborted()
    const rejection = candidateMetadataRejectReason(match.file, fileName, criteria)
    if (rejection !== null) {
      notifyCandidateRejected(criteria, match.file, fileName, rejection)
      continue
    }

    if (partCandidatesInspected >= maxPartCandidates) {
      notifyCandidateRejected(criteria, match.file, fileName, 'candidate-limit')
      break
    }

    partCandidatesInspected++
    const fileId = largeFileIdOf(match.file.fileId)
    const uploadedPartsResult = await collectResumePartInfo(raw, accountInfo, fileId, {
      maxPages: criteria.maxPartPages ?? DEFAULT_MAX_RESUME_PART_PAGES,
      maxParts: criteria.parts.length,
      ...(signal !== undefined ? { signal } : {}),
    })
    const uploadedParts = uploadedPartsResult.parts
    if (uploadedPartsResult.truncated || !uploadedPartsMatchPlan(uploadedParts, criteria.parts)) {
      notifyCandidateRejected(criteria, match.file, fileName, 'part-length-mismatch')
      continue
    }

    return { fileId, uploadedPartSha1s: partInfoToSha1s(uploadedParts) }
  }

  return null
}

interface CollectResumePartInfoOptions {
  readonly signal?: AbortSignal
  readonly maxPages?: number
  readonly maxParts?: number
}

async function collectResumePartInfo(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  options: CollectResumePartInfoOptions,
): Promise<{ readonly parts: Map<number, ResumePartInfo>; readonly truncated: boolean }> {
  const parts = new Map<number, ResumePartInfo>()
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY
  const maxParts = options.maxParts ?? Number.POSITIVE_INFINITY
  let startPartNumber: number | undefined
  let pageCount = 0

  while (pageCount < maxPages) {
    options.signal?.throwIfAborted()
    // Fetch one part beyond the local plan so a candidate with extra uploaded
    // parts is detected and rejected instead of silently reused.
    const remainingParts =
      maxParts === Number.POSITIVE_INFINITY
        ? undefined
        : Math.max(1, Math.min(1000, maxParts - parts.size + 1))
    const page = await abortableRequest(
      raw.listParts(
        accountInfo.getApiUrl(),
        accountInfo.getAuthToken(),
        {
          fileId,
          ...(startPartNumber !== undefined ? { startPartNumber } : {}),
          ...(remainingParts !== undefined ? { maxPartCount: remainingParts } : {}),
        },
        options.signal !== undefined ? { signal: options.signal } : undefined,
      ),
      options.signal,
    )
    pageCount++
    for (const part of page.parts) {
      parts.set(part.partNumber, {
        contentSha1: part.contentSha1,
        contentLength: part.contentLength,
      })
      if (parts.size > maxParts) return { parts, truncated: true }
    }
    if (page.nextPartNumber === null) return { parts, truncated: false }
    startPartNumber = page.nextPartNumber
  }

  return { parts, truncated: true }
}

function compareNewestFirst(
  a: { file: UnfinishedLargeFile; sequence: number },
  b: { file: UnfinishedLargeFile; sequence: number },
): number {
  const aTime = a.file.uploadTimestamp ?? Number.NEGATIVE_INFINITY
  const bTime = b.file.uploadTimestamp ?? Number.NEGATIVE_INFINITY
  if (aTime !== bTime) return bTime - aTime
  return b.sequence - a.sequence
}

function candidateMetadataRejectReason(
  candidate: UnfinishedLargeFile,
  fileName: string,
  criteria: ResumeCandidateCriteria,
): ResumeCandidateRejectedReason | null {
  if (candidate.fileName !== fileName) return 'file-name-mismatch'
  if (
    criteria.contentType === 'b2/x-auto' &&
    criteria.resumeFileId === undefined &&
    candidate.contentType !== 'b2/x-auto'
  ) {
    return 'content-type-mismatch'
  }
  if (criteria.contentType !== 'b2/x-auto' && candidate.contentType !== criteria.contentType) {
    return 'content-type-mismatch'
  }

  const candidateInfo = splitResumeFileInfo(candidate.fileInfo ?? {})
  if (!recordEquals(candidateInfo.fileInfo, criteria.fileInfo)) return 'file-info-mismatch'
  if (
    candidateInfo.sourceSize !== undefined &&
    candidateInfo.sourceSize !== String(criteria.sourceSize)
  ) {
    return 'source-size-mismatch'
  }
  if (
    candidateInfo.partSize !== undefined &&
    candidateInfo.partSize !== String(criteria.partSize)
  ) {
    return 'part-size-mismatch'
  }

  const encryptionRejectReason = serverSideEncryptionRejectReason(
    candidate.serverSideEncryption,
    criteria.serverSideEncryption,
  )
  if (encryptionRejectReason !== null) return encryptionRejectReason
  if (
    !fileRetentionMatches(
      candidate.fileRetention,
      criteria.fileRetention,
      criteria.defaultFileRetention,
      criteria.defaultFileRetentionUnreadable === true,
      candidate.uploadTimestamp,
    )
  ) {
    return 'retention-mismatch'
  }
  if (!legalHoldMatches(candidate.legalHold, criteria.legalHold)) {
    return 'legal-hold-mismatch'
  }

  return null
}

function notifyCandidateRejected(
  criteria: ResumeCandidateCriteria,
  candidate: UnfinishedLargeFile,
  requestedFileName: string,
  reason: ResumeCandidateRejectedReason,
): void {
  emitCandidateRejected(criteria, {
    fileId: largeFileIdOf(candidate.fileId),
    requestedFileName,
    candidateFileName: candidate.fileName,
    reason,
  })
}

function emitCandidateRejected(
  criteria: ResumeCandidateCriteria,
  event: ResumeCandidateRejectedEvent,
): void {
  try {
    criteria.onCandidateRejected?.(event)
  } catch {
    // Diagnostic listeners should not make an otherwise valid upload fail.
  }
}

function uploadedPartsMatchPlan(
  uploadedParts: ReadonlyMap<number, ResumePartInfo>,
  plans: readonly ResumePartPlan[],
): boolean {
  for (const [partNumber, part] of uploadedParts) {
    const planned = plans[partNumber - 1]
    if (planned === undefined) return false
    if (planned.partNumber !== partNumber) return false
    if (planned.length !== part.contentLength) return false
  }
  return true
}

function partInfoToSha1s(parts: ReadonlyMap<number, ResumePartInfo>): Map<number, string> {
  const sha1s = new Map<number, string>()
  for (const [partNumber, part] of parts) {
    sha1s.set(partNumber, part.contentSha1)
  }
  return sha1s
}

function recordEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

interface SplitResumeFileInfo {
  readonly fileInfo: Record<string, string>
  readonly sourceSize?: string
  readonly partSize?: string
}

function splitResumeFileInfo(fileInfo: Record<string, string>): SplitResumeFileInfo {
  const userFileInfo: Record<string, string> = Object.create(null) as Record<string, string>
  let sourceSize: string | undefined
  let partSize: string | undefined
  for (const [key, value] of Object.entries(fileInfo)) {
    if (key === RESUME_SOURCE_SIZE_INFO_KEY) {
      sourceSize = value
    } else if (key === RESUME_PART_SIZE_INFO_KEY) {
      partSize = value
    } else {
      userFileInfo[key] = value
    }
  }
  return {
    fileInfo: userFileInfo,
    ...(sourceSize !== undefined ? { sourceSize } : {}),
    ...(partSize !== undefined ? { partSize } : {}),
  }
}

function fileRetentionMatches(
  candidate: ReadableFileRetention | undefined,
  expected: FileRetentionValue | undefined,
  defaultExpected: BucketRetentionPolicy | undefined,
  defaultUnreadable: boolean,
  uploadTimestamp: number | undefined,
): boolean {
  if (expected === undefined && defaultUnreadable) return false
  if (expected === undefined && defaultExpected !== undefined) {
    if (defaultExpected.mode === BucketRetentionMode.None) {
      if (candidate === undefined) return true
      if (!candidate.isClientAuthorizedToRead) return false
      return fileRetentionValueEquals(candidate.value, null)
    }
    if (candidate === undefined || !candidate.isClientAuthorizedToRead) return false
    return fileRetentionValueMatchesBucketDefault(candidate.value, defaultExpected, uploadTimestamp)
  }
  if (expected === undefined) {
    if (candidate === undefined) return true
    if (!candidate.isClientAuthorizedToRead) return false
    return fileRetentionValueEquals(candidate.value, null)
  }
  if (candidate === undefined || !candidate.isClientAuthorizedToRead) return false
  return fileRetentionValueEquals(candidate.value, expected)
}

function fileRetentionValueMatchesBucketDefault(
  candidate: FileRetentionValue | null,
  expected: BucketRetentionPolicy,
  uploadTimestamp: number | undefined,
): boolean {
  if (expected.period === null) return false
  if (candidate?.mode !== expected.mode || candidate.retainUntilTimestamp === null) return false
  if (uploadTimestamp === undefined) return false
  return candidate.retainUntilTimestamp === uploadTimestamp + retentionPeriodMillis(expected.period)
}

function retentionPeriodMillis(period: BucketRetentionPolicy['period']): number {
  if (period === null) return 0
  const days = period.unit === 'days' ? period.duration : period.duration * 365
  return days * 24 * 60 * 60 * 1000
}

function fileRetentionValueEquals(
  a: FileRetentionValue | null,
  b: FileRetentionValue | null,
): boolean {
  return (
    (a?.mode ?? null) === (b?.mode ?? null) &&
    (a?.retainUntilTimestamp ?? null) === (b?.retainUntilTimestamp ?? null)
  )
}

function legalHoldMatches(
  candidate: ReadableLegalHold | undefined,
  expected: LegalHoldValue | undefined,
): boolean {
  if (expected === undefined) {
    if (candidate === undefined) return true
    if (!candidate.isClientAuthorizedToRead) return false
    return candidate.value === null || candidate.value === 'off'
  }
  if (candidate === undefined || !candidate.isClientAuthorizedToRead) return false
  return candidate.value === expected
}

interface ResumeDiscoverySignal {
  readonly signal?: AbortSignal
  dispose(): void
}

function createResumeDiscoverySignal(criteria: ResumeCandidateCriteria): ResumeDiscoverySignal {
  if (criteria.signal !== undefined) {
    return {
      signal: criteria.signal,
      dispose() {},
    }
  }

  if (criteria.discoveryTimeoutMs === undefined) {
    return {
      dispose() {},
    }
  }

  const timeoutMs = criteria.discoveryTimeoutMs
  if (timeoutMs === Number.POSITIVE_INFINITY) {
    return {
      dispose() {},
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(
    () => {
      controller.abort(resumeDiscoveryTimeoutReason(timeoutMs))
    },
    Math.max(0, timeoutMs),
  )

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout)
    },
  }
}

async function abortableRequest<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return request
  if (signal.aborted) throw resumeAbortReason(signal)

  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(resumeAbortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([request, aborted])
  } finally {
    removeAbortListener?.()
    void request.catch(() => {})
  }
}

function resumeAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? resumeAbortFallbackReason()
}

function resumeAbortFallbackReason(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Resume discovery aborted', 'AbortError')
  }
  const error = new Error('Resume discovery aborted')
  error.name = 'AbortError'
  return error
}

function resumeDiscoveryTimeoutReason(timeoutMs: number): Error {
  if (typeof DOMException === 'function') {
    return new DOMException(`Resume discovery timed out after ${timeoutMs} ms`, 'TimeoutError')
  }
  const error = new Error(`Resume discovery timed out after ${timeoutMs} ms`)
  error.name = 'TimeoutError'
  return error
}

type ListedEncryption = PublicEncryptionSetting | undefined

function serverSideEncryptionRejectReason(
  candidate: ListedEncryption,
  expected: EncryptionSetting | undefined,
): 'encryption-mismatch' | 'sse-c-unsupported' | null {
  if (expected?.mode === EncryptionMode.SseC) return 'sse-c-unsupported'

  const actual = normalizeEncryption(candidate)
  if (expected === undefined) {
    if (candidate === undefined) return null
    if (actual === undefined) return 'encryption-mismatch'
    if (actual.mode === EncryptionMode.None) return null
    if (actual.mode === EncryptionMode.SseB2) return null
    return actual.mode === EncryptionMode.SseC ? 'sse-c-unsupported' : 'encryption-mismatch'
  }

  const normalizedExpected = normalizeEncryption(expected)
  if (normalizedExpected?.mode === EncryptionMode.None && candidate === undefined) return null
  if (actual === undefined || normalizedExpected === undefined) return 'encryption-mismatch'
  if (actual.mode !== normalizedExpected.mode) return 'encryption-mismatch'
  if (actual.mode === EncryptionMode.None) return null
  return actual.algorithm === normalizedExpected.algorithm ? null : 'encryption-mismatch'
}

interface NormalizedEncryption {
  readonly mode: EncryptionMode
  readonly algorithm?: string
}

function normalizeEncryption(
  encryption: EncryptionSetting | ListedEncryption,
): NormalizedEncryption | undefined {
  if (encryption === undefined) return undefined
  // Real B2 responses may spell no encryption as `{ mode: null, algorithm: null }`.
  if (encryption.mode === null || encryption.mode === EncryptionMode.None) {
    return { mode: EncryptionMode.None }
  }
  if (encryption.mode !== EncryptionMode.SseB2 && encryption.mode !== EncryptionMode.SseC) {
    return undefined
  }
  return {
    mode: encryption.mode,
    algorithm: encryption.algorithm,
  }
}
