import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'

/**
 * Strategy for comparing source and destination files.
 *
 * The `sha1` mode compares 40-character hexadecimal SHA-1 digests as a practical drift
 * detector. Digest case is normalized before comparison. Missing, null, unavailable, or
 * non-verifiable metadata cannot prove equality: the high-level synchronizer either transfers
 * conservatively for untrusted metadata or skips action generation with a surfaced event when a
 * B2 file has no comparable digest. This is not a cryptographic integrity or tamper-proofing
 * guarantee, because SHA-1 collisions are possible.
 */
export type CompareMode = 'modtime' | 'size' | 'sha1' | 'none'

/** Strategy for handling destination files not present in the source. */
export type KeepMode = 'no-delete' | 'delete' | 'keep-days'

/** Direction of a sync operation. */
export type SyncDirection = 'local-to-b2' | 'b2-to-local' | 'b2-to-b2'

/** Common metadata for a file discovered during a folder scan. */
export interface SyncPath {
  /** Path relative to the sync folder root, using forward slashes. */
  readonly relativePath: string
  /** Last modification time in milliseconds since epoch. */
  readonly modTimeMillis: number
  /** File size in bytes. */
  readonly size: number
  /**
   * SHA-1 checksum state for compare modes that need content hashes.
   *
   * - `undefined`: not computed yet; the synchronizer may hash local files before comparing.
   * - `null`: known to be unavailable; `sha1` sync skips the pair with a surfaced event.
   * - 40-character hex string: known verifiable digest.
   * - other string: untrusted provider metadata such as B2's `unverified:<hex>` sentinel;
   *   consumers must not treat it as proof that bytes match. The `sha1` synchronizer must
   *   verify untrusted B2 bytes before using them for equality, or transfer conservatively.
   */
  readonly contentSha1?: string | null
}

/** A file on the local filesystem discovered during a scan. */
export interface LocalSyncPath extends SyncPath {
  /** Absolute filesystem path to the file. */
  readonly absolutePath: string
}

/** A file in a B2 bucket discovered during a scan. */
export interface B2SyncPath extends SyncPath {
  /** The most recent visible file version. */
  readonly selectedVersion: FileVersion
  /** All versions of this file, sorted newest first. */
  readonly allVersions: FileVersion[]
}

/** Discriminated event types emitted during synchronization. */
export type SyncEventType =
  | 'upload-start'
  | 'upload-done'
  | 'download-start'
  | 'download-done'
  | 'copy-start'
  | 'copy-done'
  | 'hide'
  | 'delete-remote'
  | 'delete-local'
  | 'skip'
  | 'error'
  | 'compare'

/**
 * Action event types: per-file transfer or metadata-change outcomes that
 * always carry a `path` and a `size`. Skips are reported separately as
 * {@link SyncSkipEvent} because they carry a diagnostic `message`.
 */
export type SyncActionEventType =
  | 'upload-start'
  | 'upload-done'
  | 'download-start'
  | 'download-done'
  | 'copy-start'
  | 'copy-done'
  | 'hide'
  | 'delete-remote'
  | 'delete-local'

/**
 * Per-action progress event (transfer or metadata change). All
 * action-event variants share the same shape; the `type` tag distinguishes
 * them.
 */
export interface SyncActionEvent {
  /** Discriminant tag identifying which action this event reports. */
  readonly type: SyncActionEventType
  /** Relative path of the file this event concerns. */
  readonly path: string
  /** Size in bytes of the file involved, or `0` for metadata-only actions. */
  readonly size: number
}

/** Per-file comparison progress event. */
export interface SyncCompareEvent {
  /** Discriminant tag (always the literal string `'compare'`). */
  readonly type: 'compare'
  /** Relative path of the compared file. */
  readonly path: string
  /** Reserved for compatibility with earlier metadata-only compare events. */
  readonly size: 0
  /** Local file bytes hashed while preparing this comparison, if any. */
  readonly bytesHashed: number
}

/**
 * `skip` event — a destination-only file that policy decided to keep, or
 * a same-on-both file that didn't need transfer. Always carries a
 * non-empty `message` explaining why.
 */
export interface SyncSkipEvent {
  /** Discriminant tag (always the literal string `'skip'`). */
  readonly type: 'skip'
  /** Relative path of the skipped file. */
  readonly path: string
  /** Size in bytes of the file involved, always 0 for skip events. */
  readonly size: number
  /** Human-readable reason for skipping this file. */
  readonly message: string
}

/**
 * `error` event — an action threw or the engine encountered a fatal
 * condition. Always carries a non-empty `message` describing the failure
 * so consumers don't need a `message ?? 'unknown'` fallback.
 */
export interface SyncErrorEvent {
  /** Discriminant tag (always the literal string `'error'`). */
  readonly type: 'error'
  /** Relative path of the file the failed action targeted, or `''` for engine-level errors. */
  readonly path: string
  /** Size in bytes; always 0 for error events. */
  readonly size: number
  /** Human-readable error message; never empty. */
  readonly message: string
}

/**
 * An event emitted by the sync engine to report progress, skip
 * decisions, or errors. Discriminated by `type`: consumers can
 * `case 'error':` (or `'skip':`) to narrow into a variant with `message`
 * guaranteed non-optional.
 */
export type SyncEvent = SyncActionEvent | SyncCompareEvent | SyncSkipEvent | SyncErrorEvent

/** Configuration options for a sync operation. */
export interface SyncOptions {
  /** How to decide whether two files differ. */
  readonly compareMode: CompareMode
  /** What to do with destination files absent from the source. */
  readonly keepMode: KeepMode
  /** Number of days to retain orphaned destination files when keepMode is 'keep-days'. */
  readonly keepDays?: number
  /** Maximum number of concurrent transfer actions. Defaults to 4. */
  readonly concurrency?: number
  /** When true, actions are generated but not executed. */
  readonly dryRun?: boolean
  /** Tolerance for comparison (bytes for size, milliseconds for modtime). */
  readonly compareThreshold?: number
  /** Signal to abort the sync operation, including scans and in-progress SHA-1 reads. */
  readonly signal?: AbortSignal
  /** Optional idle/no-progress timeout in milliseconds for SHA-1 reads in `sha1` mode. */
  readonly sha1ReadTimeoutMillis?: number
  /** Optional absolute deadline in milliseconds for untrusted B2 SHA-1 verification reads. */
  readonly sha1VerificationTimeoutMillis?: number
  /** Optional absolute byte ceiling for untrusted B2 SHA-1 verification reads. */
  readonly sha1VerificationMaxBytes?: number
  /** Optional provider for per-file encryption settings. */
  readonly encryptionProvider?: SyncEncryptionProvider
}

/** Options passed to folder scanners by the sync engine. */
export interface SyncScanOptions {
  /** Signal used to stop a scan before it runs to completion. */
  readonly signal?: AbortSignal
  /** Receives scan diagnostics before the scanner aborts. */
  readonly onError?: (event: SyncErrorEvent) => void
}

/** Supplies encryption settings on a per-file basis during sync. */
export interface SyncEncryptionProvider {
  /** Returns the encryption setting to use when uploading a file, or undefined for default. */
  getSettingForUpload(fileName: string, size: number): EncryptionSetting | undefined
  /** Returns the encryption setting to use when downloading a file, or undefined for default. */
  getSettingForDownload(fileVersion: FileVersion): EncryptionSetting | undefined
}

/** A scannable folder (local or B2) that yields files in deterministic string order. */
export interface SyncFolder {
  /** Whether this folder is local or in B2. */
  readonly type: 'local' | 'b2'
  /** Scans the folder and yields files sorted by relative path using JavaScript `<`/`>` order. */
  scan(options?: SyncScanOptions): AsyncIterable<SyncPath>
}
