/**
 * Sync engine for mirroring files between local folders and B2 buckets.
 *
 * The pipeline is: scan folders, pair files by relative path, generate actions
 * based on comparison and keep policies, then execute with bounded concurrency.
 *
 * @packageDocumentation
 */

export type {
  SyncAction,
  SyncActionType,
} from './actions/index.ts'
export {
  CopyAction,
  DeleteLocalAction,
  DeleteRemoteAction,
  DownloadAction,
  HideAction,
  SkipAction,
  UploadAction,
} from './actions/index.ts'
export type { SyncPair } from './pairing.ts'
export { zipFolders } from './pairing.ts'
export { filesAreDifferent } from './policies/compare.ts'
export type { ActionFactory } from './policies/index.ts'
export { generateActions } from './policies/index.ts'
export { B2Folder } from './scanners/b2.ts'
export { LocalFolder } from './scanners/local.ts'
export type {
  B2SyncFolder,
  LocalSyncFolder,
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
export { synchronize } from './synchronizer.ts'
export type {
  B2SyncPath,
  CompareMode,
  KeepMode,
  LocalSyncPath,
  SyncActionEvent,
  SyncActionEventType,
  SyncCompareEvent,
  SyncDirection,
  SyncEncryptionProvider,
  SyncErrorEvent,
  SyncEvent,
  SyncEventType,
  SyncFolder,
  SyncOptions,
  SyncPath,
  SyncScanOptions,
  SyncSkipEvent,
} from './types.ts'
