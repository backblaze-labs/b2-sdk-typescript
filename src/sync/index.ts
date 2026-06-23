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
export {
  directoryMayContainSyncPaths,
  filterSyncPaths,
  literalPrefixForSyncFilters,
  pathPassesSyncFilters,
  pathSkippedByRegExpInputLimit,
} from './filters.ts'
export type { SyncPair } from './pairing.ts'
export { zipFolders } from './pairing.ts'
export { compareSyncRelativePaths } from './path-order.ts'
export { filesAreDifferent } from './policies/compare.ts'
export type { ActionFactory } from './policies/index.ts'
export { generateActions } from './policies/index.ts'
export {
  asRawB2KeyPrefix,
  b2KeyToRelativePathUnderPrefix,
  normalizeB2RelativePath,
} from './prefix.ts'
export { B2Folder } from './scanners/b2.ts'
export { LocalFolder } from './scanners/local.ts'
export type {
  SyncSha1PendingState,
  SyncSha1State,
  SyncSha1UnavailableState,
  SyncSha1UntrustedState,
  SyncSha1VerifiedState,
} from './sha1-metadata.ts'
export {
  isUntrustedSha1,
  parseSyncContentSha1,
  selectB2ComparableSha1,
  syncSha1StateOf,
  untrustedSha1,
  untrustedSha1Prefix,
} from './sha1-metadata.ts'
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
  LocalFileIdentity,
  LocalSyncPath,
  SyncActionEvent,
  SyncActionEventType,
  SyncCompareEvent,
  SyncDirection,
  SyncEncryptionProvider,
  SyncErrorEvent,
  SyncEvent,
  SyncEventType,
  SyncFilterOptions,
  SyncFilterPattern,
  SyncFolder,
  SyncOptions,
  SyncPath,
  SyncScanOptions,
  SyncSkipEvent,
  SyncSkipReason,
} from './types.ts'
