import type { FileVersion } from '../types/file.ts'
import { normalizeVerifiableSha1 } from '../util/sha1.ts'

/** Prefix used to mark SHA-1 metadata that must not prove equality without byte verification. */
export const untrustedSha1Prefix = 'unverified:'

/** SHA-1 has not been computed or populated yet. */
export interface SyncSha1PendingState {
  /** State discriminator. */
  readonly kind: 'pending'
}

/** SHA-1 is known to be unavailable for this path. */
export interface SyncSha1UnavailableState {
  /** State discriminator. */
  readonly kind: 'unavailable'
}

/** SHA-1 is a normalized 40-character digest that may prove equality. */
export interface SyncSha1VerifiedState {
  /** State discriminator. */
  readonly kind: 'verified'
  /** Normalized lowercase 40-character SHA-1 digest. */
  readonly value: string
}

/** SHA-1 metadata is present but cannot prove equality without verification. */
export interface SyncSha1UntrustedState {
  /** State discriminator. */
  readonly kind: 'untrusted'
  /** Normalized digest when one can be extracted from the raw metadata. */
  readonly value: string | null
  /** Original metadata string supplied by the scanner or B2 file version. */
  readonly raw: string
}

/** Public SHA-1 state used by sync scanners and low-level compare helpers. */
export type SyncSha1State =
  | SyncSha1PendingState
  | SyncSha1UnavailableState
  | SyncSha1VerifiedState
  | SyncSha1UntrustedState

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

/**
 * Parses the public `SyncPath.contentSha1` value into an explicit trust/availability state.
 *
 * @param sha1 - The raw `contentSha1` field from a sync path.
 *
 * @returns A discriminated state so custom scanners do not need to decode sentinels directly.
 */
export function parseSyncContentSha1(sha1: string | null | undefined): SyncSha1State {
  if (sha1 === undefined) return { kind: 'pending' }
  if (sha1 === null) return { kind: 'unavailable' }
  if (isUntrustedSha1(sha1)) {
    return {
      kind: 'untrusted',
      raw: sha1,
      value: normalizeVerifiableSha1(sha1.slice(untrustedSha1Prefix.length)),
    }
  }
  const normalized = normalizeVerifiableSha1(sha1)
  if (normalized === null) return { kind: 'untrusted', raw: sha1, value: null }
  return { kind: 'verified', value: normalized }
}

/**
 * Reads an explicit SHA-1 state when present, otherwise parses the compatibility field.
 *
 * @param path - Object carrying SHA-1 metadata.
 *
 * @returns The explicit or parsed SHA-1 state.
 */
export function syncSha1StateOf(path: {
  readonly contentSha1?: string | null
  readonly contentSha1State?: SyncSha1State
}): SyncSha1State {
  return path.contentSha1State ?? parseSyncContentSha1(path.contentSha1)
}
