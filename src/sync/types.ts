import type { EncryptionSetting } from '../types/encryption.js'
import type { FileVersion } from '../types/file.js'

export type CompareMode = 'modtime' | 'size' | 'none'
export type KeepMode = 'no-delete' | 'delete' | 'keep-days'
export type SyncDirection = 'local-to-b2' | 'b2-to-local' | 'b2-to-b2'

export interface SyncPath {
  readonly relativePath: string
  readonly modTimeMillis: number
  readonly size: number
}

export interface LocalSyncPath extends SyncPath {
  readonly absolutePath: string
}

export interface B2SyncPath extends SyncPath {
  readonly selectedVersion: FileVersion
  readonly allVersions: FileVersion[]
}

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

export interface SyncEvent {
  readonly type: SyncEventType
  readonly path: string
  readonly size: number
  readonly message?: string
}

export interface SyncOptions {
  readonly compareMode: CompareMode
  readonly keepMode: KeepMode
  readonly keepDays?: number
  readonly concurrency?: number
  readonly dryRun?: boolean
  readonly compareThreshold?: number
  readonly signal?: AbortSignal
  readonly encryptionProvider?: SyncEncryptionProvider
}

export interface SyncEncryptionProvider {
  getSettingForUpload(fileName: string, size: number): EncryptionSetting | undefined
  getSettingForDownload(fileVersion: FileVersion): EncryptionSetting | undefined
}

export interface SyncFolder {
  readonly type: 'local' | 'b2'
  scan(): AsyncIterable<SyncPath>
}
