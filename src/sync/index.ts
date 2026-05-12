/**
 * Sync engine for mirroring files between local folders and B2 buckets.
 *
 * The pipeline is: scan folders, pair files by relative path, generate actions
 * based on comparison and keep policies, then execute with bounded concurrency.
 *
 * @packageDocumentation
 */

export { LocalFolder } from './scanners/local.js'
export { B2Folder } from './scanners/b2.js'
export { zipFolders } from './pairing.js'
export { generateActions } from './policies/index.js'
export { filesAreDifferent } from './policies/compare.js'
export { synchronize } from './synchronizer.js'
export type {
  SyncAction,
  SyncActionType,
} from './actions/index.js'
export {
  UploadAction,
  DownloadAction,
  CopyAction,
  HideAction,
  DeleteRemoteAction,
  DeleteLocalAction,
  SkipAction,
} from './actions/index.js'
export type {
  CompareMode,
  KeepMode,
  SyncDirection,
  SyncPath,
  LocalSyncPath,
  B2SyncPath,
  SyncEvent,
  SyncEventType,
  SyncOptions,
  SyncEncryptionProvider,
  SyncFolder,
} from './types.js'
export type { ActionFactory } from './policies/index.js'
export type { SyncPair } from './pairing.js'
export type {
  SynchronizerConfig,
  SynchronizerUpConfig,
  SynchronizerDownConfig,
  LocalSyncFolder,
  B2SyncFolder,
} from './synchronizer.js'
