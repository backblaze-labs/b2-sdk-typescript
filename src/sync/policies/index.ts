import type { SyncAction } from '../actions/index.js'
import { SkipAction } from '../actions/index.js'
import type { SyncPair } from '../pairing.js'
import type {
  B2SyncPath,
  CompareMode,
  KeepMode,
  LocalSyncPath,
  SyncDirection,
  SyncPath,
} from '../types.js'
import { filesAreDifferent } from './compare.js'

export interface ActionFactory {
  upload(source: LocalSyncPath): SyncAction
  download(source: B2SyncPath): SyncAction
  copy(source: B2SyncPath, destPath: string): SyncAction
  hide(path: string): SyncAction
  deleteRemote(path: B2SyncPath): SyncAction
  deleteLocal(path: LocalSyncPath): SyncAction
}

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
      yield factory.hide(dest.relativePath)
      yield factory.deleteRemote(dest as B2SyncPath)
      break
    case 'b2-to-local':
      yield factory.deleteLocal(dest as LocalSyncPath)
      break
    case 'b2-to-b2':
      yield factory.deleteRemote(dest as B2SyncPath)
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
