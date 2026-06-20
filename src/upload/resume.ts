import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import type { BucketId, LargeFileId } from '../types/ids.ts'
import { largeFileId as largeFileIdOf } from '../types/ids.ts'

/** Information about an unfinished large file eligible for resume. */
export interface ResumeCandidate {
  /** ID of the unfinished large file. */
  readonly fileId: LargeFileId
  /** SHA-1 of each part already uploaded, indexed by 1-based part number. */
  readonly uploadedPartSha1s: ReadonlyMap<number, string>
}

/** Options for unfinished large-file resume discovery. */
export interface FindResumeCandidateOptions {
  /**
   * When true, list already-uploaded parts and return their server SHA-1 values.
   * Leave false unless the caller will trust those SHA-1s to skip uploads.
   */
  readonly collectUploadedPartSha1s?: boolean
}

/**
 * Finds an unfinished large file matching the given bucket and file name.
 * Returns `null` when no matching candidate exists.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Target bucket of the upload.
 * @param fileName - Destination file name of the upload.
 * @param options - Optional controls for whether uploaded part SHA-1s are listed.
 *
 * @returns A {@link ResumeCandidate} describing the candidate and its uploaded parts, or `null`.
 */
export async function findResumeCandidate(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: BucketId,
  fileName: string,
  options: FindResumeCandidateOptions = {},
): Promise<ResumeCandidate | null> {
  const unfinished = await raw.listUnfinishedLargeFiles(
    accountInfo.getApiUrl(),
    accountInfo.getAuthToken(),
    { bucketId },
  )

  const match = unfinished.files.find((f) => f.fileName === fileName)
  if (!match) return null

  const fileId = largeFileIdOf(match.fileId)
  const uploadedPartSha1s =
    options.collectUploadedPartSha1s === true
      ? await collectPartSha1s(raw, accountInfo, fileId)
      : new Map<number, string>()

  return { fileId, uploadedPartSha1s }
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
  const sha1s = new Map<number, string>()
  let startPartNumber: number | undefined

  while (true) {
    const page = await raw.listParts(accountInfo.getApiUrl(), accountInfo.getAuthToken(), {
      fileId,
      ...(startPartNumber !== undefined ? { startPartNumber } : {}),
    })
    for (const part of page.parts) {
      sha1s.set(part.partNumber, part.contentSha1)
    }
    if (page.nextPartNumber === null) break
    startPartNumber = page.nextPartNumber
  }

  return sha1s
}
