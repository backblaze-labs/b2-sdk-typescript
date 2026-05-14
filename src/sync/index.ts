/**
 * Sync engine for mirroring files between local folders and B2 buckets.
 *
 * The pipeline is: scan folders, pair files by relative path, generate actions
 * based on comparison and keep policies, then execute with bounded concurrency.
 *
 * @packageDocumentation
 */

export { LocalFolder } from './scanners/local.ts'
export { B2Folder } from './scanners/b2.ts'
export { zipFolders } from './pairing.ts'
export { generateActions } from './policies/index.ts'
export { filesAreDifferent } from './policies/compare.ts'
export { synchronize } from './synchronizer.ts'
export type {
  SyncAction,
  SyncActionType,
} from './actions/index.ts'
export {
  UploadAction,
  DownloadAction,
  CopyAction,
  HideAction,
  DeleteRemoteAction,
  DeleteLocalAction,
  SkipAction,
} from './actions/index.ts'
export type {
  CompareMode,
  KeepMode,
  SyncDirection,
  SyncPath,
  LocalSyncPath,
  B2SyncPath,
  SyncEvent,
  SyncEventType,
  SyncActionEvent,
  SyncActionEventType,
  SyncSkipEvent,
  SyncErrorEvent,
  SyncOptions,
  SyncEncryptionProvider,
  SyncFolder,
} from './types.ts'
export type { ActionFactory } from './policies/index.ts'
export type { SyncPair } from './pairing.ts'
export type {
  SynchronizerConfig,
  SynchronizerUpConfig,
  SynchronizerDownConfig,
  LocalSyncFolder,
  B2SyncFolder,
} from './synchronizer.ts'
