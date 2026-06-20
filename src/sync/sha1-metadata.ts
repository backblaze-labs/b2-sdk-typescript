import type { FileVersion } from '../types/file.ts'
import { normalizeVerifiableSha1 } from '../util/sha1.ts'

/** Prefix used to mark SHA-1 metadata that must not prove equality without byte verification. */
export const untrustedSha1Prefix = 'unverified:'

/**
 * Marks a verifiable SHA-1 digest as untrusted provider metadata.
 *
 * @param sha1 - Verifiable 40-character hexadecimal SHA-1 digest.
 *
 * @returns The untrusted SHA-1 sentinel value.
 *
 * @throws When the supplied value is not a verifiable SHA-1 digest.
 */
export function untrustedSha1(sha1: string): string {
  const normalized = normalizeVerifiableSha1(sha1)
  if (normalized === null) throw new Error('untrusted SHA-1 metadata must be verifiable')
  return `${untrustedSha1Prefix}${normalized}`
}

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
  const originalContentSha1 = version.contentSha1
  if (typeof originalContentSha1 === 'string') {
    if (isUntrustedSha1(originalContentSha1)) return originalContentSha1.toLowerCase()
    const contentSha1 = normalizeVerifiableSha1(originalContentSha1)
    return contentSha1 ?? originalContentSha1.toLowerCase()
  }

  const largeFileSha1 = normalizeVerifiableSha1(version.fileInfo['large_file_sha1'])
  return largeFileSha1 === null ? null : untrustedSha1(largeFileSha1)
}

/**
 * Returns whether a SHA-1 value is marked as untrusted metadata.
 *
 * @param sha1 - Candidate SHA-1 metadata.
 *
 * @returns True when the value carries B2's unverified sentinel prefix.
 */
export function isUntrustedSha1(sha1: string | null | undefined): boolean {
  return sha1?.toLowerCase().startsWith(untrustedSha1Prefix) ?? false
}
