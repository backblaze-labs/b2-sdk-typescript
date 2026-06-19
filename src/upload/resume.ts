import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { EncryptionMode, type EncryptionSetting } from '../types/encryption.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { largeFileId as largeFileIdOf } from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue } from '../types/lock.ts'
import type { UnfinishedLargeFile } from '../types/upload.ts'

/** SDK-managed file-info key storing the source byte length for resumable uploads. */
export const RESUME_SOURCE_SIZE_INFO_KEY = 'b2_sdk_resume_source_size'

/** SDK-managed file-info key storing the effective multipart part size for resumable uploads. */
export const RESUME_PART_SIZE_INFO_KEY = 'b2_sdk_resume_part_size'

/** One planned part from the local upload source. */
export interface ResumePartPlan {
  /** 1-based B2 part number. */
  readonly partNumber: number
  /** Expected byte length for this part. */
  readonly length: number
}

/** Compatibility requirements an unfinished large file must satisfy before reuse. */
export interface ResumeCandidateCriteria {
  /** Effective MIME type for the upload, including SDK defaults. */
  readonly contentType: string
  /** Expected file info, including SDK-managed resume identity keys. */
  readonly fileInfo: Record<string, string>
  /** Source size in bytes, used when the candidate carries SDK resume metadata. */
  readonly sourceSize?: number
  /** Effective multipart part size, used when the candidate carries SDK resume metadata. */
  readonly partSize?: number
  /** Planned local parts used to verify already-uploaded server part lengths. */
  readonly parts?: readonly ResumePartPlan[]
  /** Explicit server-side encryption option, if configured by the caller. */
  readonly serverSideEncryption?: EncryptionSetting
  /** Explicit Object Lock retention option, if configured by the caller. */
  readonly fileRetention?: FileRetentionValue
  /** Explicit legal hold option, if configured by the caller. */
  readonly legalHold?: LegalHoldValue
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
  /** Metadata for each part already uploaded, indexed by 1-based part number. */
  readonly uploadedParts: ReadonlyMap<number, ResumePartInfo>
}

/**
 * Adds the SDK's resume identity metadata to a file-info record.
 *
 * The metadata is stored with B2's unfinished large-file record, then checked
 * on later `resume: true` attempts before an unfinished upload is reused.
 *
 * @param fileInfo - User-supplied file info.
 * @param sourceSize - Source byte length.
 * @param partSize - Effective multipart part size.
 *
 * @returns A new file-info record with SDK-managed resume identity keys.
 */
export function withResumeIdentityFileInfo(
  fileInfo: Record<string, string>,
  sourceSize: number,
  partSize: number,
): Record<string, string> {
  return {
    ...fileInfo,
    [RESUME_SOURCE_SIZE_INFO_KEY]: String(sourceSize),
    [RESUME_PART_SIZE_INFO_KEY]: String(partSize),
  }
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
 * Finds an explicitly selected unfinished large file matching the given bucket and file name.
 * Returns `null` when no matching candidate exists.
 * When criteria are provided, the newest compatible matching candidate is
 * selected; incompatible same-name uploads are ignored.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Target bucket of the upload.
 * @param fileName - Destination file name of the upload.
 * @param criteria - Optional upload identity and option checks.
 *
 * @returns A {@link ResumeCandidate} describing the candidate and its uploaded parts, or `null`.
 */
export async function findResumeCandidate(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
  fileName: string,
  criteria?: ResumeCandidateCriteria,
): Promise<ResumeCandidate | null> {
  const matches: Array<{ file: UnfinishedLargeFile; sequence: number }> = []
  let sequence = 0
  let startFileId: LargeFileId | undefined

  while (true) {
    const unfinished = await raw.listUnfinishedLargeFiles(
      accountInfo.getApiUrl(),
      accountInfo.getAuthToken(),
      {
        bucketId,
        namePrefix: fileName,
        maxFileCount: 100,
        ...(startFileId !== undefined ? { startFileId } : {}),
      },
    )

    for (const file of unfinished.files) {
      if (file.fileName === fileName) {
        matches.push({ file, sequence })
      }
      sequence++
    }

    if (unfinished.nextFileId === null) break
    startFileId = unfinished.nextFileId
  }

  matches.sort(compareNewestFirst)

  for (const match of matches) {
    if (criteria !== undefined && !candidateMetadataMatches(match.file, criteria)) {
      continue
    }

    const fileId = largeFileIdOf(match.file.fileId)
    const uploadedParts = await collectPartInfo(raw, accountInfo, fileId)
    if (criteria?.parts !== undefined && !uploadedPartsMatchPlan(uploadedParts, criteria.parts)) {
      continue
    }

    const uploadedPartSha1s = new Map<number, string>()
    for (const [partNumber, part] of uploadedParts) {
      uploadedPartSha1s.set(partNumber, part.contentSha1)
    }

    return { fileId, uploadedPartSha1s, uploadedParts }
  }

  return null
}

/**
 * Lists all uploaded parts for a large file, paginating until exhausted.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - ID of the large file to inspect.
 *
 * @returns A map from 1-based part number to its server-stored SHA-1.
 */
export async function collectPartSha1s(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
): Promise<Map<number, string>> {
  const parts = await collectPartInfo(raw, accountInfo, fileId)
  const sha1s = new Map<number, string>()
  for (const [partNumber, part] of parts) {
    sha1s.set(partNumber, part.contentSha1)
  }
  return sha1s
}

/**
 * Lists all uploaded parts for a large file, including byte lengths.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param fileId - ID of the large file to inspect.
 *
 * @returns A map from 1-based part number to part resume metadata.
 */
export async function collectPartInfo(
  raw: RawClient,
  accountInfo: AccountInfo,
  fileId: LargeFileId,
): Promise<Map<number, ResumePartInfo>> {
  const parts = new Map<number, ResumePartInfo>()
  let startPartNumber: number | undefined

  while (true) {
    const page = await raw.listParts(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId,
      ...(startPartNumber !== undefined ? { startPartNumber } : {}),
    })
    for (const part of page.parts) {
      parts.set(part.partNumber, {
        contentSha1: part.contentSha1,
        contentLength: part.contentLength,
      })
    }
    if (page.nextPartNumber === null) break
    startPartNumber = page.nextPartNumber
  }

  return parts
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

function candidateMetadataMatches(
  candidate: UnfinishedLargeFile,
  criteria: ResumeCandidateCriteria,
): boolean {
  if (candidate.contentType !== criteria.contentType) return false
  if (!recordEquals(candidate.fileInfo ?? {}, criteria.fileInfo)) return false
  if (!serverSideEncryptionMatches(candidate.serverSideEncryption, criteria.serverSideEncryption)) {
    return false
  }
  if (!fileRetentionMatches(candidate.fileRetention, criteria.fileRetention)) return false
  if (!legalHoldMatches(candidate.legalHold, criteria.legalHold)) return false

  const sourceSize = candidate.fileInfo?.[RESUME_SOURCE_SIZE_INFO_KEY]
  if (
    sourceSize !== undefined &&
    criteria.sourceSize !== undefined &&
    sourceSize !== String(criteria.sourceSize)
  ) {
    return false
  }

  const partSize = candidate.fileInfo?.[RESUME_PART_SIZE_INFO_KEY]
  if (
    partSize !== undefined &&
    criteria.partSize !== undefined &&
    partSize !== String(criteria.partSize)
  ) {
    return false
  }

  return true
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

function recordEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

type ReadableFileRetention =
  | {
      readonly isClientAuthorizedToRead: boolean
      readonly value: FileRetentionValue | null
    }
  | FileRetentionValue
  | null
  | undefined

function fileRetentionMatches(
  candidate: ReadableFileRetention,
  expected: FileRetentionValue | undefined,
): boolean {
  const actual = normalizeReadableValue(candidate)
  if (expected === undefined) {
    if (actual === undefined) return true
    if (!actual.readable) return false
    return fileRetentionValueEquals(actual.value, null)
  }
  if (actual === undefined || !actual.readable) return false
  return fileRetentionValueEquals(actual.value, expected)
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

type ReadableLegalHold =
  | {
      readonly isClientAuthorizedToRead: boolean
      readonly value: LegalHoldValue | null
    }
  | LegalHoldValue
  | null
  | undefined

function legalHoldMatches(candidate: ReadableLegalHold, expected: LegalHoldValue | undefined) {
  const actual = normalizeReadableValue(candidate)
  if (expected === undefined) {
    if (actual === undefined) return true
    if (!actual.readable) return false
    return actual.value === null || actual.value === 'off'
  }
  if (actual === undefined || !actual.readable) return false
  return actual.value === expected
}

function normalizeReadableValue<T>(
  candidate:
    | {
        readonly isClientAuthorizedToRead: boolean
        readonly value: T | null
      }
    | T
    | null
    | undefined,
): { readonly readable: boolean; readonly value: T | null } | undefined {
  if (candidate === undefined) return undefined
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'isClientAuthorizedToRead' in candidate
  ) {
    return {
      readable: candidate.isClientAuthorizedToRead,
      value: candidate.isClientAuthorizedToRead ? candidate.value : null,
    }
  }
  return { readable: true, value: candidate }
}

type ListedEncryption =
  | EncryptionSetting
  | { readonly mode: null; readonly algorithm?: null }
  | { readonly mode?: string | null; readonly algorithm?: string | null }
  | undefined

function serverSideEncryptionMatches(
  candidate: ListedEncryption,
  expected: EncryptionSetting | undefined,
): boolean {
  const actual = normalizeEncryption(candidate)
  if (expected === undefined) {
    return (
      actual === undefined ||
      actual.mode === EncryptionMode.None ||
      actual.mode === EncryptionMode.SseB2
    )
  }

  const normalizedExpected = normalizeEncryption(expected)
  if (actual === undefined || normalizedExpected === undefined) return false
  if (actual.mode !== normalizedExpected.mode) return false
  if (actual.mode === EncryptionMode.None) return true
  return actual.algorithm === normalizedExpected.algorithm
}

function normalizeEncryption(
  encryption: ListedEncryption,
): { readonly mode: EncryptionMode; readonly algorithm?: string } | undefined {
  if (encryption === undefined) return undefined
  if (encryption.mode === null || encryption.mode === undefined || encryption.mode === 'none') {
    return { mode: EncryptionMode.None }
  }
  if (encryption.mode === EncryptionMode.SseB2 || encryption.mode === EncryptionMode.SseC) {
    return {
      mode: encryption.mode,
      ...(encryption.algorithm !== undefined && encryption.algorithm !== null
        ? { algorithm: encryption.algorithm }
        : {}),
    }
  }
  return undefined
}
