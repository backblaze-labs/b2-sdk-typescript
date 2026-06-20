import type { FileVersion } from '../types/file.ts'
import { normalizeVerifiableSha1 } from '../util/sha1.ts'

const unverifiedSha1Prefix = 'unverified:'

/**
 * Extracts the best comparable SHA-1 value from a B2 file version.
 *
 * B2's primary `contentSha1` is authoritative for single-part uploads when it is a verifiable
 * digest. Large/multipart B2 files report `contentSha1: null`; `fileInfo.large_file_sha1` is
 * caller-provided metadata, so it is returned as an untrusted hint that cannot prove equality
 * until the high-level synchronizer hashes the selected version's bytes.
 *
 * @param version - B2 file version metadata.
 *
 * @returns A lowercase comparable SHA-1, an untrusted sentinel, or null when unavailable.
 */
export function selectB2ComparableSha1(version: FileVersion): string | null {
  if (isUntrustedSha1(version.contentSha1)) return version.contentSha1.toLowerCase()
  const contentSha1 = normalizeVerifiableSha1(version.contentSha1)
  if (contentSha1 !== null) return contentSha1

  const largeFileSha1 = normalizeVerifiableSha1(version.fileInfo['large_file_sha1'])
  return largeFileSha1 === null ? null : `${unverifiedSha1Prefix}${largeFileSha1}`
}

/**
 * Returns whether a SHA-1 value is marked as untrusted metadata.
 *
 * @param sha1 - Candidate SHA-1 metadata.
 *
 * @returns True when the value carries B2's unverified sentinel prefix.
 */
export function isUntrustedSha1(sha1: string | null | undefined): sha1 is string {
  return sha1?.toLowerCase().startsWith(unverifiedSha1Prefix) ?? false
}
