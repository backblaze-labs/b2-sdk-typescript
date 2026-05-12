import type { EncryptionSetting } from '../types/encryption.js'
import type { FileVersion } from '../types/file.js'

/** Strategy for comparing source and destination files: by modification time, size, or skip comparison. */
export type CompareMode = 'modtime' | 'size' | 'none'

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

/** An event emitted by the sync engine to report progress or errors. */
export interface SyncEvent {
  /** The kind of event. */
  readonly type: SyncEventType
  /** Relative path of the file this event concerns. */
  readonly path: string
  /** Size in bytes of the file involved, or 0 for metadata-only events. */
  readonly size: number
  /** Optional human-readable detail (e.g. error message or skip reason). */
  readonly message?: string
}

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
  /** Signal to abort the sync operation. */
  readonly signal?: AbortSignal
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

/** A scannable folder (local or B2) that yields files in sorted order. */
export interface SyncFolder {
  /** Whether this folder is local or in B2. */
  readonly type: 'local' | 'b2'
  /** Scans the folder and yields files sorted by relative path. */
  scan(): AsyncIterable<SyncPath>
}
