import type { FileVersion } from '../types/file.ts'
import { normalizeVerifiableSha1 } from '../util/sha1.ts'

const unverifiedSha1Prefix = 'unverified:'

/**
 * Extracts the best comparable SHA-1 value from a B2 file version.
 *
 * Large/multipart B2 files report `contentSha1: null`; when a whole-file digest is available in
 * `fileInfo.large_file_sha1`, that value is used as a comparable hint. B2-provided hashes are
 * treated as metadata hints by the high-level synchronizer, which downloads and hashes B2 bytes
 * before using a metadata match to prove equality.
 *
 * @param version - B2 file version metadata.
 *
 * @returns A lowercase comparable SHA-1, an untrusted sentinel, or null when unavailable.
 */
export function selectB2ComparableSha1(version: FileVersion): string | null {
  if (isUntrustedSha1(version.contentSha1)) return version.contentSha1.toLowerCase()
  return (
    normalizeVerifiableSha1(version.contentSha1) ??
    normalizeVerifiableSha1(version.fileInfo['large_file_sha1'])
  )
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
