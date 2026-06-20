import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
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

/** Compatibility-only file-info key read from legacy unfinished uploads; new uploads do not write it. */
export const RESUME_SOURCE_SIZE_INFO_KEY = 'b2_sdk_resume_source_size'

/** Compatibility-only file-info key read from legacy unfinished uploads; new uploads do not write it. */
export const RESUME_PART_SIZE_INFO_KEY = 'b2_sdk_resume_part_size'

const DEFAULT_MAX_RESUME_LIST_PAGES = 10
const DEFAULT_MAX_RESUME_PART_CANDIDATES = 25
const DEFAULT_MAX_RESUME_PART_PAGES = 10

/** Thrown when an explicit resumeFileId is not compatible with the requested upload. */
export class ResumeFileIdMismatchError extends Error {
  /** Caller-supplied unfinished large file ID that failed verification. */
  readonly fileId: LargeFileId
  /** Requested destination file name. */
  readonly fileName: string

  /**
   * Creates a new resume-file ID mismatch error.
   * @param fileId - Caller-supplied unfinished large file ID that failed verification.
   * @param fileName - Requested destination file name.
   */
  constructor(fileId: LargeFileId, fileName: string) {
    super('uploadLargeFile: resumeFileId does not identify a compatible unfinished large file.')
    this.name = 'ResumeFileIdMismatchError'
    this.fileId = fileId
    this.fileName = fileName
  }
}

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
  readonly fileName: string
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
}

/** Uploaded part metadata used by the resume planner. */
export interface ResumePartInfo {
  /** SHA-1 stored by B2 for this uploaded part. */
  readonly contentSha1: string
  /** Byte length stored by B2 for this uploaded part. */
  readonly contentLength: number
}

/** Information about an unfinished large file eligible for resume. */
export interface ResumeCandidate {
  /** ID of the unfinished large file. */
  readonly fileId: LargeFileId
  /** SHA-1 of each part already uploaded, indexed by 1-based part number. */
  readonly uploadedPartSha1s: ReadonlyMap<number, string>
}

/** Options for unfinished large-file resume discovery. */
export interface FindResumeCandidateOptions {
  /** Explicit unfinished large-file ID selected by the caller. */
  readonly resumeFileId?: LargeFileId
  /**
   * When true, list already-uploaded parts and return their server SHA-1 values.
   * Leave false unless the caller will trust those SHA-1s to skip uploads.
   */
  readonly collectUploadedPartSha1s?: boolean
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
  const matches: Array<{ file: UnfinishedLargeFile; sequence: number }> = []
  const maxListPages = criteria.maxListPages ?? DEFAULT_MAX_RESUME_LIST_PAGES
  const maxPartCandidates = criteria.maxPartCandidates ?? DEFAULT_MAX_RESUME_PART_CANDIDATES
  let sequence = 0
  let pageCount = 0
  const explicitResumeFileId = criteria.resumeFileId
  let startFileId: LargeFileId | undefined = explicitResumeFileId
  let truncated = false

  while (pageCount < maxListPages) {
    criteria.signal?.throwIfAborted()
    const unfinished = await raw.listUnfinishedLargeFiles(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      {
        bucketId,
        maxFileCount: explicitResumeFileId === undefined ? 100 : 1,
        ...(explicitResumeFileId === undefined ? { namePrefix: fileName } : {}),
        ...(startFileId !== undefined ? { startFileId } : {}),
      },
      criteria.signal !== undefined ? { signal: criteria.signal } : undefined,
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
      fileName,
      requestedFileName: fileName,
      reason: 'search-truncated',
    })
  }

  matches.sort(compareNewestFirst)

  let partCandidatesInspected = 0
  for (const match of matches) {
    criteria.signal?.throwIfAborted()
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
      ...(criteria.signal !== undefined ? { signal: criteria.signal } : {}),
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

/**
 * Lists all uploaded parts for a large file, paginating until exhausted.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - ID of the large file to inspect.
 * @param signal - Optional abort signal used for B2 list requests and checked between pages.
 *
 * @returns A map from 1-based part number to its server-stored SHA-1.
 */
export async function collectPartSha1s(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const parts = await collectPartInfo(raw, accountInfo, fileId, signal)
  return partInfoToSha1s(parts)
}

/**
 * Lists all uploaded parts for a large file, including byte lengths.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - ID of the large file to inspect.
 * @param signal - Optional abort signal used for B2 list requests and checked between pages.
 *
 * @returns A map from 1-based part number to part resume metadata.
 */
export async function collectPartInfo(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
  signal?: AbortSignal,
): Promise<Map<number, ResumePartInfo>> {
  const result = await collectResumePartInfo(
    raw,
    accountInfo,
    fileId,
    signal !== undefined ? { signal } : {},
  )
  return result.parts
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
    const remainingParts =
      maxParts === Number.POSITIVE_INFINITY
        ? undefined
        : Math.max(1, Math.min(1000, maxParts - parts.size + 1))
    const page = await raw.listParts(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      {
        fileId,
        ...(startPartNumber !== undefined ? { startPartNumber } : {}),
        ...(remainingParts !== undefined ? { maxPartCount: remainingParts } : {}),
      },
      options.signal !== undefined ? { signal: options.signal } : undefined,
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
  if (candidate.contentType !== criteria.contentType) return 'content-type-mismatch'

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
  if (!fileRetentionMatches(candidate.fileRetention, criteria.fileRetention)) {
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
    fileName: requestedFileName,
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
    criteria?.onCandidateRejected?.(event)
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
  const userFileInfo: Record<string, string> = {}
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
): boolean {
  if (expected === undefined) {
    if (candidate === undefined) return true
    if (!candidate.isClientAuthorizedToRead) return false
    return fileRetentionValueEquals(candidate.value, null)
  }
  if (candidate === undefined || !candidate.isClientAuthorizedToRead) return false
  return fileRetentionValueEquals(candidate.value, expected)
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
