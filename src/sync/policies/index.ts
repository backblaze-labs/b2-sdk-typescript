import type { SyncAction } from '../actions/index.ts'
import { SkipAction } from '../actions/index.ts'
import type { SyncPair } from '../pairing.ts'
import type {
  B2SyncPath,
  CompareMode,
  KeepMode,
  LocalSyncPath,
  SyncDirection,
  SyncPath,
} from '../types.ts'
import { filesAreDifferent } from './compare.ts'

/** Factory for creating concrete sync actions. Used by {@link generateActions} to decouple policy from execution. */
export interface ActionFactory {
  /** Creates an action to upload a local file to B2. */
  upload(source: LocalSyncPath): SyncAction
  /** Creates an action to download a B2 file to the local filesystem. */
  download(source: B2SyncPath): SyncAction
  /** Creates an action to server-side copy a B2 file to a new destination path. */
  copy(source: B2SyncPath, destPath: string): SyncAction
  /** Creates an action to hide a file in B2 (soft delete). */
  hide(path: string): SyncAction
  /** Creates an action to permanently delete a remote B2 file version. */
  deleteRemote(path: B2SyncPath): SyncAction
  /** Creates an action to delete a local file. */
  deleteLocal(path: LocalSyncPath): SyncAction
  /**
   * Creates the right "remove this orphan from B2" action for the bucket's
   * configuration: a hide on a file-lock-enabled bucket (where direct
   * delete may be blocked or stack hide markers), a plain
   * delete-file-version on a vanilla bucket. Used by `actionsForDestOnly`
   * to avoid yielding both a hide AND a delete when only one of them is
   * the correct semantic for the destination bucket.
   */
  removeOrphan(dest: B2SyncPath): SyncAction
}

/**
 * Converts a paired source/dest tuple into zero or more sync actions based on the
 * sync direction, compare mode, and keep policy.
 * For `compareMode: 'sha1'`, low-level callers should pass a pair prepared by
 * `preparePairForCompare()` so local file hashes and server-verifiable B2 hashes are populated.
 *
 * @param pair - The source/dest file pair from {@link zipFolders}.
 * @param direction - The sync direction.
 * @param compareMode - How to compare files for differences.
 * @param keepMode - Policy for destination-only files.
 * @param keepDays - Retention period when keepMode is 'keep-days'.
 * @param nowMillis - Current time in milliseconds, used for keep-days calculation.
 * @param factory - Factory to create the concrete action objects.
 * @param compareThreshold - Tolerance for the comparison.
 */
export function* generateActions(
  pair: SyncPair,
  direction: SyncDirection,
  compareMode: CompareMode,
  keepMode: KeepMode,
  keepDays: number,
  nowMillis: number,
  factory: ActionFactory,
  compareThreshold: number,
): Generator<SyncAction> {
  const [source, dest] = pair

  if (source !== null && dest === null) {
    yield* actionsForSourceOnly(source, direction, factory)
  } else if (source === null && dest !== null) {
    yield* actionsForDestOnly(dest, direction, keepMode, keepDays, nowMillis, factory)
  } else if (source !== null && dest !== null) {
    yield* actionsForBoth(source, dest, direction, compareMode, compareThreshold, factory)
  }
}

function* actionsForSourceOnly(
  source: SyncPath,
  direction: SyncDirection,
  factory: ActionFactory,
): Generator<SyncAction> {
  switch (direction) {
    case 'local-to-b2':
      yield factory.upload(source as LocalSyncPath)
      break
    case 'b2-to-local':
      yield factory.download(source as B2SyncPath)
      break
    case 'b2-to-b2':
      yield factory.copy(source as B2SyncPath, source.relativePath)
      break
  }
}

function* actionsForDestOnly(
  dest: SyncPath,
  direction: SyncDirection,
  keepMode: KeepMode,
  keepDays: number,
  nowMillis: number,
  factory: ActionFactory,
): Generator<SyncAction> {
  if (keepMode === 'no-delete') {
    yield new SkipAction(dest.relativePath, 'not in source, keep-mode is no-delete')
    return
  }

  if (keepMode === 'keep-days') {
    const ageMillis = nowMillis - dest.modTimeMillis
    const ageDays = ageMillis / (24 * 60 * 60 * 1000)
    if (ageDays < keepDays) {
      yield new SkipAction(
        dest.relativePath,
        `not in source, keeping for ${Math.ceil(keepDays - ageDays)} more days`,
      )
      return
    }
  }

  switch (direction) {
    case 'local-to-b2':
      // Single action — `removeOrphan` picks hide vs delete based on
      // the destination bucket's `fileLockEnabled` state. The previous
      // "yield both" behaviour stacked hide markers on vanilla buckets
      // even though the delete that followed made them redundant.
      yield factory.removeOrphan(dest as B2SyncPath)
      break
    case 'b2-to-local':
      yield factory.deleteLocal(dest as LocalSyncPath)
      break
    case 'b2-to-b2':
      yield factory.removeOrphan(dest as B2SyncPath)
      break
  }
}

function* actionsForBoth(
  source: SyncPath,
  dest: SyncPath,
  direction: SyncDirection,
  compareMode: CompareMode,
  compareThreshold: number,
  factory: ActionFactory,
): Generator<SyncAction> {
  if (!filesAreDifferent(source, dest, compareMode, compareThreshold)) {
    yield new SkipAction(source.relativePath, 'files are the same')
    return
  }

  switch (direction) {
    case 'local-to-b2':
      yield factory.upload(source as LocalSyncPath)
      break
    case 'b2-to-local':
      yield factory.download(source as B2SyncPath)
      break
    case 'b2-to-b2':
      yield factory.copy(source as B2SyncPath, dest.relativePath)
      break
  }
}
