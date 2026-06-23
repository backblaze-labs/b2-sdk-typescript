import type { EncryptionSetting } from '../types/encryption.ts'
import type { FileVersion } from '../types/file.ts'
import type { SyncSha1State } from './sha1-metadata.ts'

/**
 * Strategy for comparing source and destination files.
 *
 * The `sha1` mode compares 40-character hexadecimal SHA-1 digests as a practical drift
 * detector. Digest case is normalized before comparison. Missing, null, unavailable, or
 * non-verifiable metadata cannot prove equality: the high-level synchronizer either transfers
 * conservatively for untrusted metadata or skips action generation with a surfaced event when a
 * B2 file has no comparable digest. Untrusted B2 metadata may require downloading the selected
 * B2 version to hash its bytes before equality can be trusted. This is not a cryptographic
 * integrity or tamper-proofing guarantee, because SHA-1 collisions are possible.
 */
export type CompareMode = 'modtime' | 'size' | 'sha1' | 'none'

/** Strategy for handling destination files not present in the source. */
export type KeepMode = 'no-delete' | 'delete' | 'keep-days'

/** Direction of a sync operation. */
export type SyncDirection = 'local-to-b2' | 'b2-to-local' | 'b2-to-b2'

/**
 * Glob string or regular expression used to include or exclude sync paths.
 *
 * Glob strings use a small SDK-defined dialect against folder-relative paths with forward
 * slashes: `*` and `?` match within one path segment, and a path segment that is exactly `**`
 * matches across directory boundaries. Character classes, brace expansion, extglobs, and
 * backslash escaping are not supported. Slash-less globs use basename-style matching at any
 * directory depth, so `*.tmp` matches `nested/file.tmp` and `readme.md` matches both `readme.md`
 * and `docs/readme.md`. They also match ancestor directory names, so `node_modules` matches every
 * file under a `node_modules` directory. Exclude filters win over include filters.
 *
 * Regular expressions are matched against the full relative path. Global and sticky flags are
 * ignored so matching does not mutate `lastIndex`. RegExp acceptance is a best-effort safety
 * heuristic for synchronous matching, and the exact accepted subset may change as the SDK tightens
 * protection. Current guards reject overly long sources, backreferences, multiple unbounded
 * quantifiers, large or excessive bounded quantifiers, and quantified groups whose subtree
 * contains a quantifier or alternation.
 * When any RegExp filter is configured, paths longer than the SDK's RegExp input guard are skipped
 * instead of being fed to the JavaScript RegExp engine. This is fail-closed for deny-lists: an
 * untestable long path is not allowed through an exclude RegExp filter.
 */
export type SyncFilterPattern = string | RegExp

/**
 * Include/exclude filters applied to sync paths relative to each folder root.
 *
 * `SyncOptions.include` and `SyncOptions.exclude` are the canonical filters for
 * {@link synchronize}; they are passed down into folder scans and then enforced again during
 * pairing as the SDK policy boundary. Calling
 * {@link SyncFolder.scan} directly can pass the same filter object for standalone scans.
 */
export interface SyncFilterOptions {
  /**
   * Optional allow-list. When present, only paths matching at least one pattern are scanned.
   * B2 scans can push down only the safe literal prefix from slash-containing glob includes;
   * other include filtering is client-side.
   */
  readonly include?: readonly SyncFilterPattern[]
  /**
   * Optional deny-list. Paths matching any exclude pattern are skipped even when they also match
   * an include pattern. Excludes are client-side filters; they do not reduce B2 list API calls or
   * the B2 scanner's version grouping and sort memory.
   */
  readonly exclude?: readonly SyncFilterPattern[]
}

/**
 * Options accepted by {@link SyncFolder.scan}. Includes filters plus an optional scan-level
 * callback for paths the scanner cannot safely represent or test.
 */
export interface SyncScanOptions extends SyncFilterOptions {
  /**
   * Optional signal checked by built-in scanners while enumerating. Aborting stops local traversal
   * promptly and stops B2 scans before requesting the next page.
   */
  readonly signal?: AbortSignal
  /** Receives scan diagnostics before the scanner aborts. */
  readonly onError?: (event: SyncErrorEvent) => void
  /**
   * Receives scanner skip diagnostics. Built-in scans isolate callback errors so diagnostics
   * handlers cannot abort the scan.
   */
  readonly onSkip?: (event: SyncSkipEvent) => void
  /**
   * When true, B2 scanners skip names that cannot be written safely to a local filesystem
   * destination and reject case/Unicode-canonical local path collisions.
   */
  readonly requireLocalSafePaths?: boolean
  /**
   * Maximum number of entries a scanner may retain before failing with a defined error instead of
   * continuing toward unbounded heap growth. Defaults to the SDK scan limit.
   */
  readonly maxScanEntries?: number
}

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
   *
   * Use `parseSyncContentSha1`, `selectB2ComparableSha1`, and `untrustedSha1` from the sync
   * entrypoint to construct or inspect this field without depending on sentinel strings.
   */
  readonly contentSha1?: string | null
  /**
   * Explicit SHA-1 trust and availability state. Prefer this field for custom
   * scanners that can distinguish verified digests from untrusted provider
   * metadata without relying on `contentSha1` sentinel strings. When omitted,
   * the synchronizer derives the state from `contentSha1` for compatibility.
   */
  readonly contentSha1State?: SyncSha1State
}

/** Filesystem identity captured while scanning a local file. */
export interface LocalFileIdentity {
  /** Device ID from the local filesystem. */
  readonly deviceId: number
  /** Inode number from the local filesystem. */
  readonly inode: number
  /** Size observed during the scan. */
  readonly size: number
  /** Modification time observed during the scan, floored to milliseconds. */
  readonly modTimeMillis: number
}

/** A file on the local filesystem discovered during a scan. */
export interface LocalSyncPath extends SyncPath {
  /** Absolute filesystem path to the file. */
  readonly absolutePath: string
  /** Optional filesystem identity used to reject scan-to-read races. */
  readonly fileIdentity?: LocalFileIdentity
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

/** Machine-readable reasons emitted with scanner and diagnostic skip events. */
export type SyncSkipReason =
  | 'outside-prefix'
  | 'unsafe-name'
  | 'local-unsafe-name'
  | 'relative-path-collision'
  | 'local-path-collision'
  | 'filesystem-error'
  | 'path-too-long-for-regexp'
  | 'scan-skip-overflow'
  | 'stale-download-partial'

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
  readonly bytesHashed?: number
  /** B2 bytes downloaded and hashed while verifying untrusted SHA-1 metadata, if any. */
  readonly bytesVerified?: number
}

/**
 * `skip` event — a destination-only file that policy decided to keep, or
 * a same-on-both file that didn't need transfer. Always carries a
 * non-empty `message` explaining why.
 */
export interface SyncSkipEvent {
  /** Discriminant tag (always the literal string `'skip'`). */
  readonly type: 'skip'
  /** Relative path of the skipped file, or the raw B2 key when no safe relative path exists. */
  readonly path: string
  /** Size in bytes of the file involved, always 0 for skip events. */
  readonly size: number
  /** Human-readable reason for skipping this file. */
  readonly message: string
  /** Machine-readable skip reason when emitted by a scanner or diagnostic buffer. */
  readonly reason?: SyncSkipReason
  /** Original B2 key when the skip came from a B2 scan. */
  readonly b2FileName?: string
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
  /** Number of failed actions represented by an aggregate run-level error event. */
  readonly failureCount?: number
  /** Bounded relative paths of failed actions represented by an aggregate run-level error event. */
  readonly failedPaths?: readonly string[]
  /** Number of failed action paths omitted from a bounded aggregate error event. */
  readonly failedPathOmittedCount?: number
}

/**
 * An event emitted by the sync engine to report progress, skip
 * decisions, or errors. Discriminated by `type`: consumers can
 * `case 'error':` (or `'skip':`) to narrow into a variant with `message`
 * guaranteed non-optional.
 */
export type SyncEvent = SyncActionEvent | SyncCompareEvent | SyncSkipEvent | SyncErrorEvent

/** Configuration options for a sync operation. */
export interface SyncOptions extends SyncFilterOptions {
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
  /**
   * Optional absolute deadline in milliseconds for untrusted B2 SHA-1 verification reads.
   * Objects that cannot be fully verified before this deadline are skipped for that run.
   */
  readonly sha1VerificationTimeoutMillis?: number
  /**
   * Optional per-file byte ceiling for untrusted B2 SHA-1 verification reads.
   *
   * By default, verifying untrusted B2 metadata may download the selected version's full
   * `contentLength` each run. Set this to a lower value to skip objects above the per-file
   * budget before they can be treated as equal.
   */
  readonly sha1VerificationMaxBytes?: number
  /** Idle timeout in milliseconds for B2-to-local download body reads. Defaults to 60 seconds. */
  readonly downloadIdleTimeoutMillis?: number
  /** Maximum scanner entries retained before failing with a defined scan-limit error. */
  readonly maxScanEntries?: number
  /** Optional provider for per-file encryption settings. */
  readonly encryptionProvider?: SyncEncryptionProvider
}

/** Supplies encryption settings on a per-file basis during sync. */
export interface SyncEncryptionProvider {
  /** Returns the encryption setting to use when uploading a file, or undefined for default. */
  getSettingForUpload(fileName: string, size: number): EncryptionSetting | undefined
  /** Returns the encryption setting to use when downloading a file, or undefined for default. */
  getSettingForDownload(fileVersion: FileVersion): EncryptionSetting | undefined
}

/**
 * A scannable folder (local or B2) that yields files relative to its sync root.
 *
 * Built-in scanners currently sort before yielding. Large local trees or B2 prefixes may therefore
 * require memory proportional to the scanned entries; B2 scans also group listed versions before
 * yielding. For B2, `maxScanEntries` counts every listed file version before prefix, safety, and
 * filter checks, and exclude filters or non-literal includes do not bound B2 listing calls.
 */
export interface SyncFolder {
  /** Whether this folder is local or in B2. */
  readonly type: 'local' | 'b2'
  /**
   * True when `scan(filters)` already enforces include/exclude filters itself as an optimization.
   * The synchronizer still reapplies filters after custom scanner output as the SDK policy
   * boundary. Custom folders that set this should use the exported filter helpers from
   * `@backblaze-labs/b2-sdk/sync` to stay aligned with the SDK glob and RegExp dialect.
   */
  readonly appliesScanFilters?: true
  /**
   * True when `scan(filters)` already yields entries in `compareSyncRelativePaths` order.
   * Custom folders that omit this are sorted by `synchronize()` before pairing.
   */
  readonly appliesScanSorting?: true
  /** Scans the folder and yields files relative to the folder root. */
  scan(options?: SyncScanOptions): AsyncIterable<SyncPath>
}
