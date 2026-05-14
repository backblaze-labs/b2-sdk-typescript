import type { AccountInfo } from '../auth/account-info.ts'
import type { RawClient } from '../raw/index.ts'
import { type LargeFileId, largeFileId as largeFileIdOf } from '../types/ids.ts'
import type { PartInfo } from '../types/upload.ts'

/** Information about an unfinished large file eligible for resume. */
export interface ResumeCandidate {
  /** ID of the unfinished large file. */
  readonly fileId: LargeFileId
  /** SHA-1 of each part already uploaded, indexed by 1-based part number. */
  readonly uploadedPartSha1s: ReadonlyMap<number, string>
}

/**
 * Finds an unfinished large file matching the given bucket and file name.
 * Returns `null` when no matching candidate exists.
 *
 * @param raw - Low-level B2 API client.
 * @param accountInfo - Authorized account state.
 * @param bucketId - Target bucket of the upload.
 * @param fileName - Destination file name of the upload.
 *
 * @returns A {@link ResumeCandidate} describing the candidate and its uploaded parts, or `null`.
 */
export async function findResumeCandidate(
  raw: RawClient,
  accountInfo: AccountInfo,
  bucketId: string,
  fileName: string,
): Promise<ResumeCandidate | null> {
  const unfinished = await raw.listUnfinishedLargeFiles(
    accountInfo.getApiUrl(),
    accountInfo.getAuthToken(),
    { bucketId: bucketId as never },
  )

  const match = unfinished.files.find((f) => f.fileName === fileName)
  if (!match) return null

  const fileId = largeFileIdOf(match.fileId)
  const uploadedPartSha1s = await collectPartSha1s(raw, accountInfo, fileId)

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
    for (const part of page.parts as readonly PartInfo[]) {
      sha1s.set(part.partNumber, part.contentSha1)
    }
    if (page.nextPartNumber === null) break
    startPartNumber = page.nextPartNumber
  }

  return sha1s
}
