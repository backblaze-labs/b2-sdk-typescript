import type { Bucket } from '../bucket.ts'
import type { SseCDownloadKey } from '../raw/index.ts'
import { BufferSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import { fileId as fileIdOf } from '../types/ids.ts'
import { DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { sanitizeErrorReason } from '../util/error-reason.ts'
import type { SyncAction } from './actions/index.ts'
import {
  CopyAction,
  DeleteLocalAction,
  DeleteRemoteAction,
  DownloadAction,
  HideAction,
  SkipAction,
  UploadAction,
} from './actions/index.ts'
import {
  hashReadableStreamSha1,
  normalizeSha1VerificationMaxBytes,
  withSha1VerificationDeadline,
} from './b2-sha1-reader.ts'
import { readScannedLocalFile, writeLocalStreamInsideRoot } from './local-file-io.ts'
import { readLocalSha1File } from './local-sha1.ts'
import { type SyncPair, zipFolders } from './pairing.ts'
import { safeRelativePathSegments } from './path-safety.ts'
import {
  assertSupportedCompareMode,
  type B2Sha1Reader,
  type ComparePreparationResult,
  preparePairsForCompare,
  readyComparePair,
} from './policies/compare.ts'
import type { ActionFactory } from './policies/index.ts'
import { generateActions } from './policies/index.ts'
import { normalizeB2FolderPrefix } from './prefix.ts'
import {
  DEFAULT_SHA1_VERIFICATION_TIMEOUT_MILLIS,
  normalizeSha1TimeoutMillis,
} from './sha1-options.ts'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncDirection,
  SyncEvent,
  SyncFolder,
  SyncOptions,
  SyncScanOptions,
} from './types.ts'

const MAX_BUFFERED_SCAN_EVENTS = 100

interface ScanEventBuffer {
  readonly events: SyncEvent[]
  dropped: number
}

/** Base configuration for a sync operation. */
export interface SynchronizerConfig {
  /** The folder to read files from. */
  readonly source: SyncFolder
  /** The folder to write files to. */
  readonly dest: SyncFolder
  /** Options controlling comparison, deletion policy, and concurrency. */
  readonly options: SyncOptions
}

/** A sync folder constrained to the local filesystem. */
export interface LocalSyncFolder extends SyncFolder {
  /** Discriminant identifying a local folder. */
  readonly type: 'local'
  /** Absolute filesystem path to the local root directory. */
  readonly root: string
}

/** A sync folder constrained to a B2 bucket prefix. */
export interface B2SyncFolder extends SyncFolder {
  /** Discriminant identifying a B2 folder. */
  readonly type: 'b2'
}

/** Configuration for a local-to-B2 sync (upload direction). */
export interface SynchronizerUpConfig extends SynchronizerConfig {
  /** Local source folder. */
  readonly source: LocalSyncFolder
  /** B2 destination folder. */
  readonly dest: B2SyncFolder
  /** The target B2 bucket. */
  readonly bucket: Bucket
  /**
   * Raw B2 key prefix for uploaded files in the bucket.
   * Backslashes are preserved as raw B2 key characters.
   */
  readonly prefix: string
}

/** Configuration for a B2-to-local sync (download direction). */
export interface SynchronizerDownConfig extends SynchronizerConfig {
  /** B2 source folder. */
  readonly source: B2SyncFolder
  /** Local destination folder. */
  readonly dest: LocalSyncFolder
  /** The source B2 bucket. */
  readonly bucket: Bucket
}

interface PreparedActionPlan {
  readonly event: SyncEvent
  readonly actions: readonly SyncAction[]
}

/**
 * Infers the sync direction from the source and destination folder types.
 * @param source - The folder to read files from.
 * @param dest - The folder to write files to.
 *
 * @returns The resolved sync direction based on folder types.
 *
 * @throws When the source and destination folder types form an unsupported combination.
 */
function resolveDirection(source: SyncFolder, dest: SyncFolder): SyncDirection {
  if (source.type === 'local' && dest.type === 'b2') return 'local-to-b2'
  if (source.type === 'b2' && dest.type === 'local') return 'b2-to-local'
  if (source.type === 'b2' && dest.type === 'b2') return 'b2-to-b2'
  throw new Error(`Unsupported sync direction: ${source.type} to ${dest.type}`)
}

/**
 * Runs a full sync operation: scans both folders, pairs files, generates actions,
 * and executes them with bounded concurrency. Yields {@link SyncEvent} entries for
 * each comparison and action result.
 *
 * @param config - The synchronizer configuration (source, dest, options, and optional bucket).
 */
export async function* synchronize(config: SynchronizerConfig): AsyncGenerator<SyncEvent> {
  const { source, dest, options } = config
  assertSupportedCompareMode(options.compareMode)
  const direction = resolveDirection(source, dest)
  const dryRun = options.dryRun ?? false
  const concurrency = normalizeSyncConcurrency(options.concurrency)
  const keepDays = options.keepDays ?? 0
  const compareThreshold = options.compareThreshold ?? 0
  const nowMillis = Date.now()
  const queuedEvents: SyncEvent[] = []
  let errorCount = 0
  let scanHadError = false
  const runningActions = new Set<Promise<void>>()
  const scanEvents: ScanEventBuffer = { events: [], dropped: 0 }
  const scanOptions: SyncScanOptions = {
    ...(options.include !== undefined ? { include: options.include } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onSkip(event) {
      bufferScanEvent(scanEvents, event)
    },
    onError: (event) => {
      scanHadError = true
      errorCount += 1
      queueEvent(event)
    },
  }

  const factory = createActionFactory(config)
  const readB2Sha1 = dryRun ? undefined : createB2Sha1Reader(config)

  async function* finishAfterAbort(): AsyncGenerator<SyncEvent> {
    await drainActions()
    yield* emitQueuedEvents()
  }

  try {
    try {
      if (options.compareMode === 'sha1') {
        const compareBatchSize = concurrency
        let batch: SyncPair[] = []
        for await (const pair of zipFolders(source, dest, scanOptions)) {
          if (options.signal?.aborted) {
            yield* finishAfterAbort()
            return
          }
          batch.push(pair)
          if (batch.length >= compareBatchSize) {
            if (yield* emitSha1Batch(batch)) return
            batch = []
          }
        }

        if (yield* emitSha1Batch(batch)) return
      } else {
        for await (const pair of zipFolders(source, dest, scanOptions)) {
          if (options.signal?.aborted) {
            yield* finishAfterAbort()
            return
          }
          const item = planPreparedPair(pair, readyComparePair(pair))
          if (yield* emitPreparedItems([item])) return
        }
      }
    } catch (err) {
      await drainActions()
      if (!scanHadError) throw err

      yield* emitQueuedEvents()
      yield {
        type: 'error',
        path: '',
        size: 0,
        message: `${errorCount} sync error(s) occurred`,
      }
      return
    }

    await drainActions()

    yield* emitQueuedEvents()

    if (errorCount > 0) {
      yield {
        type: 'error',
        path: '',
        size: 0,
        message: `${errorCount} sync error(s) occurred`,
      }
    }
  } finally {
    await drainActions()
  }

  async function* emitSha1Batch(batch: readonly SyncPair[]): AsyncGenerator<SyncEvent, boolean> {
    if (batch.length === 0) return false

    // Keep SHA-1 hashing / B2 verification and transfer actions under one effective
    // concurrency ceiling. This intentionally creates a batch barrier instead of
    // overlapping compare reads with prior transfers.
    await drainActions()
    yield* emitQueuedEvents()

    const preparedBatch = await processPreparedBatch(batch)
    if (yield* emitPreparedItems(preparedBatch.items)) return true
    if (preparedBatch.aborted || options.signal?.aborted) {
      yield* finishAfterAbort()
      return true
    }
    return false
  }

  async function* emitPreparedItems(
    items: readonly PreparedActionPlan[],
  ): AsyncGenerator<SyncEvent, boolean> {
    for (const item of items) {
      yield item.event
      yield* emitQueuedEvents()
      /* v8 ignore next -- abort between compare yield and scheduling is timing-dependent */
      if (options.signal?.aborted) {
        yield* finishAfterAbort()
        return true
      }
      for (const action of item.actions) {
        await scheduleAction(action)
        yield* emitQueuedEvents()
      }
    }
    return false
  }

  async function processPreparedBatch(
    batch: readonly SyncPair[],
  ): Promise<{ readonly items: readonly PreparedActionPlan[]; readonly aborted: boolean }> {
    if (batch.length === 0) return { items: [], aborted: false }
    const preparedPairs = await preparePairsForCompare(batch, 'sha1', {
      concurrency,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.sha1ReadTimeoutMillis !== undefined
        ? { sha1ReadTimeoutMillis: options.sha1ReadTimeoutMillis }
        : {}),
      readLocalSha1: readLocalSha1File,
      ...(readB2Sha1 !== undefined ? { readB2Sha1 } : {}),
    })

    const items: PreparedActionPlan[] = []
    for (const { originalPair, prepared } of preparedPairs) {
      if (prepared.aborted || options.signal?.aborted) return { items, aborted: true }
      items.push(planPreparedPair(originalPair, prepared))
    }
    return { items, aborted: false }
  }

  function planPreparedPair(
    pair: SyncPair,
    prepared: ComparePreparationResult,
  ): PreparedActionPlan {
    const event: SyncEvent = {
      type: 'compare',
      path: (pair[0] ?? pair[1])?.relativePath ?? '',
      size: 0,
      bytesHashed: prepared.bytesHashed,
      ...(prepared.bytesVerified > 0 ? { bytesVerified: prepared.bytesVerified } : {}),
    }

    for (const preparedEvent of prepared.events) queueEvent(preparedEvent)
    errorCount += prepared.errors.length
    if (prepared.skipActionGeneration) return { event, actions: [] }
    if (scanHadError && prepared.pair[0] === null && prepared.pair[1] !== null) {
      return {
        event,
        actions: [
          new SkipAction(prepared.pair[1].relativePath, 'not removed because scan errors occurred'),
        ],
      }
    }

    const actions = [
      ...generateActions(
        prepared.pair,
        direction,
        options.compareMode,
        options.keepMode,
        keepDays,
        nowMillis,
        factory,
        compareThreshold,
      ),
    ]

    return { event, actions }
  }

  async function scheduleAction(action: SyncAction): Promise<void> {
    const task = executeAction(action).finally(() => {
      runningActions.delete(task)
    })
    runningActions.add(task)
    if (runningActions.size >= concurrency) await Promise.race(runningActions)
  }

  async function executeAction(action: SyncAction): Promise<void> {
    try {
      if (options.signal?.aborted) return
      const event = await action.execute(dryRun)
      queueEvent(event)
    } catch (err) {
      errorCount += 1
      queueEvent({
        type: 'error',
        path: action.relativePath,
        size: 0,
        message: sanitizeErrorReason(err),
      })
    }
  }

  function queueEvent(event: SyncEvent): void {
    queuedEvents.push(event)
  }

  async function* emitQueuedEvents(): AsyncGenerator<SyncEvent> {
    yield* drainScanEvents(scanEvents)
    for (const event of queuedEvents.splice(0)) yield event
  }

  async function drainActions(): Promise<void> {
    while (runningActions.size > 0) {
      await Promise.race(runningActions)
    }
  }
}

/**
 * Normalizes user-provided sync concurrency before it controls compare batches and transfers.
 *
 * @param value - Optional concurrency value from sync options.
 *
 * @returns A positive integer concurrency value.
 */
function normalizeSyncConcurrency(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TRANSFER_CONCURRENCY
  if (!Number.isFinite(candidate) || candidate < 1) return DEFAULT_TRANSFER_CONCURRENCY
  return Math.max(1, Math.floor(candidate))
}

function createB2Sha1Reader(config: SynchronizerConfig): B2Sha1Reader | undefined {
  const upConfig = config as Partial<SynchronizerUpConfig>
  const downConfig = config as Partial<SynchronizerDownConfig>
  const bucket = upConfig.bucket ?? downConfig.bucket
  if (bucket === undefined) return undefined
  const idleTimeoutMillis = normalizeSha1TimeoutMillis(config.options.sha1ReadTimeoutMillis)
  const verificationTimeoutMillis = normalizeSha1TimeoutMillis(
    config.options.sha1VerificationTimeoutMillis,
    DEFAULT_SHA1_VERIFICATION_TIMEOUT_MILLIS,
  )

  return async (path, signal) => {
    const expectedBytes = Math.max(0, Math.floor(path.selectedVersion.contentLength))
    const maxBytes = normalizeSha1VerificationMaxBytes(
      expectedBytes,
      config.options.sha1VerificationMaxBytes,
    )
    return withSha1VerificationDeadline(
      signal,
      verificationTimeoutMillis,
      async (deadlineSignal) => {
        deadlineSignal.throwIfAborted()
        if (maxBytes < expectedBytes) {
          throw new Error(
            `sha1 B2 verification skipped because contentLength ${expectedBytes} exceeds ${maxBytes} byte verification budget`,
          )
        }
        const serverSideEncryption = toSseCDownloadKey(
          config.options.encryptionProvider?.getSettingForDownload(path.selectedVersion),
        )
        const result = await bucket
          .file(path.selectedVersion.fileName)
          .downloadById(path.selectedVersion.fileId, {
            ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
            signal: deadlineSignal,
          })
        const verified = await hashReadableStreamSha1(result.body, deadlineSignal, {
          idleTimeoutMillis,
          maxBytes,
          expectedBytes,
        })
        return { contentSha1: verified.contentSha1, bytesRead: verified.bytesRead }
      },
    )
  }
}

/**
 * Narrowing assertion that a `Bucket` is present for an action that requires
 * it. Throws with a consistent, context-tagged message when the configured
 * direction did not supply one (e.g. `b2-to-local` direction asking for an
 * upload action).
 *
 * Uses TypeScript's `asserts` signature so call-site flow narrows
 * `bucket` from `Bucket | undefined` to `Bucket` after the check, without
 * requiring a separate `if (!bucket) throw ...` line per action factory.
 *
 * @param bucket - The (possibly missing) bucket reference.
 * @param context - Short verb describing the action being constructed
 *   (e.g. `'upload'`, `'download'`). Surfaced in the error message.
 *
 * @throws `Error` when `bucket` is `undefined` or `null`.
 */
function assertBucket(bucket: Bucket | undefined, context: string): asserts bucket is Bucket {
  if (!bucket) throw new Error(`Bucket required for ${context} actions`)
}

/**
 * Narrows a setting to SSE-C; non-SSE-C source settings need no key on read.
 *
 * @param setting - Provider-supplied encryption setting, or undefined.
 *
 * @returns The SSE-C setting when one is provided; otherwise undefined.
 */
function toSseCEncryptionSetting(
  setting: EncryptionSetting | undefined,
): Extract<EncryptionSetting, { readonly mode: 'SSE-C' }> | undefined {
  if (setting?.mode !== 'SSE-C') return undefined
  return setting
}

/**
 * Returns a download key from SSE-C settings; non-SSE-C downloads need no key.
 *
 * @param setting - Provider-supplied encryption setting, or undefined.
 *
 * @returns A download key for SSE-C files; otherwise undefined.
 */
function toSseCDownloadKey(setting: EncryptionSetting | undefined): SseCDownloadKey | undefined {
  return toSseCEncryptionSetting(setting)
}

/**
 * Creates a configured sync engine wired to the bucket and paths in the given config.
 *
 * For sync operations that may need to remove destination-only files (the
 * `keepMode: 'delete'` policy), the factory reads the destination
 * bucket's cached `fileLockConfiguration` once so `removeOrphan` can
 * dispatch to either `hide` (locked buckets) or `deleteFileVersion`
 * (vanilla buckets) without a per-file branch. The cache is whatever
 * `client.listBuckets()` or `client.createBucket()` returned — callers
 * who flipped lock state mid-sync (rare) should refresh before
 * synchronize().
 *
 * @param config - The synchronizer configuration containing source, destination, and options.
 *
 * @returns An action factory bound to the provided configuration.
 */
function createActionFactory(config: SynchronizerConfig): ActionFactory {
  const upConfig = config as Partial<SynchronizerUpConfig>
  const downConfig = config as Partial<SynchronizerDownConfig>

  const destBucket = upConfig.bucket ?? downConfig.bucket
  // Defensive optional chain on `info`: synchronizer tests use Bucket
  // mocks that don't populate this field. Real `Bucket` instances always
  // do (constructor parameter).
  const bucketIsLocked = destBucket?.info?.fileLockConfiguration?.value?.isFileLockEnabled ?? false

  const factory: ActionFactory = {
    upload(source: LocalSyncPath, dest?: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket
      const prefix = normalizeB2FolderPrefix(upConfig.prefix ?? '')
      assertBucket(bucket, 'upload')

      return new UploadAction(
        source.relativePath,
        source.absolutePath,
        source.size,
        async (absPath, relPath) => {
          const data = await readScannedLocalFile({ ...source, absolutePath: absPath })
          const fileName = dest?.selectedVersion.fileName ?? `${prefix}${relPath}`
          const serverSideEncryption = config.options.encryptionProvider?.getSettingForUpload(
            fileName,
            data.byteLength,
          )
          await bucket.upload({
            fileName,
            source: new BufferSource(data),
            ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
            ...(config.options.signal !== undefined ? { signal: config.options.signal } : {}),
          })
        },
      )
    },

    download(source: B2SyncPath): SyncAction {
      const bucket = downConfig.bucket
      const root =
        downConfig.dest?.type === 'local' ? (downConfig.dest as { root: string }).root : ''
      assertBucket(bucket, 'download')

      return new DownloadAction(source.relativePath, source.size, async (relPath) => {
        safeRelativePathSegments(relPath)
        const serverSideEncryption = toSseCDownloadKey(
          config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
        )
        const result = await bucket
          .file(source.selectedVersion.fileName)
          .downloadById(source.selectedVersion.fileId, {
            ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
            ...(config.options.signal !== undefined ? { signal: config.options.signal } : {}),
          })
        await writeLocalStreamInsideRoot(root, relPath, result.body, {
          expectedBytes: source.selectedVersion.contentLength,
          idleTimeoutMillis: normalizeSha1TimeoutMillis(config.options.sha1ReadTimeoutMillis),
          ...(config.options.signal !== undefined ? { signal: config.options.signal } : {}),
        })
      })
    },

    copy(source: B2SyncPath, destPath: string): SyncAction {
      const bucket = upConfig.bucket
      assertBucket(bucket, 'copy')

      return new CopyAction(source.relativePath, source.size, async () => {
        const destinationServerSideEncryption =
          config.options.encryptionProvider?.getSettingForUpload(destPath, source.size)
        const sourceServerSideEncryption = toSseCEncryptionSetting(
          config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
        )
        await bucket.copyFile({
          sourceFileId: source.selectedVersion.fileId,
          fileName: destPath,
          ...(destinationServerSideEncryption !== undefined
            ? { destinationServerSideEncryption }
            : {}),
          ...(sourceServerSideEncryption !== undefined ? { sourceServerSideEncryption } : {}),
          ...(config.options.signal !== undefined ? { signal: config.options.signal } : {}),
        })
      })
    },

    hide(path: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      assertBucket(bucket, 'hide')
      const b2FileName = path.selectedVersion.fileName

      return new HideAction(path.relativePath, async () => {
        if (config.options.signal !== undefined) {
          await bucket.hideFile(b2FileName, { signal: config.options.signal })
        } else {
          await bucket.hideFile(b2FileName)
        }
      })
    },

    deleteRemote(path: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      assertBucket(bucket, 'delete')

      // Bug fix: `DeleteRemoteAction` invokes the closure with
      // `relativePath` (the scanner-stripped name relative to the sync
      // prefix), but B2 stores files under the FULL name including the
      // prefix. Use the FileVersion's authoritative `fileName` — the
      // actual B2 key — rather than reconstructing it via prefix
      // concat. Without this, syncs with a non-empty destination
      // prefix (e.g. `'site/'`) failed orphan deletion with
      // `file_not_present`.
      const b2FileName = path.selectedVersion.fileName
      return new DeleteRemoteAction(
        path.relativePath,
        path.selectedVersion.fileId as string,
        async (fileId) => {
          if (config.options.signal !== undefined) {
            await bucket.deleteFileVersion(b2FileName, fileIdOf(fileId), {
              signal: config.options.signal,
            })
          } else {
            await bucket.deleteFileVersion(b2FileName, fileIdOf(fileId))
          }
        },
      )
    },

    deleteLocal(path: LocalSyncPath): SyncAction {
      const root =
        downConfig.dest?.type === 'local' ? (downConfig.dest as { root: string }).root : ''
      return new DeleteLocalAction(path.relativePath, path.absolutePath, async (absPath) => {
        const { unlink } = await import('node:fs/promises')
        config.options.signal?.throwIfAborted()
        const targetPath = await resolveContainedLocalPath(root, path.relativePath)
        const actualPath = await resolveContainedLocalPath(root, path.relativePath, absPath)
        if (targetPath !== actualPath) {
          throw new Error(`Refusing to delete outside sync root: ${path.relativePath}`)
        }
        await unlink(targetPath)
      })
    },

    removeOrphan(dest: B2SyncPath): SyncAction {
      // Locked buckets: `b2_delete_file_version` is blocked or stacks
      // hide markers under retention; a hide is the safe choice.
      // Vanilla buckets: plain delete is the right move — hide markers
      // would just litter the version history.
      return bucketIsLocked ? factory.hide(dest) : factory.deleteRemote(dest)
    },
  }

  return factory
}

function bufferScanEvent(buffer: ScanEventBuffer, event: SyncEvent): void {
  if (buffer.events.length < MAX_BUFFERED_SCAN_EVENTS) {
    buffer.events.push(event)
  } else {
    buffer.dropped++
  }
}

function* drainScanEvents(buffer: ScanEventBuffer): Generator<SyncEvent> {
  while (buffer.events.length > 0) {
    const event = buffer.events.shift()
    if (event) yield event
  }

  if (buffer.dropped > 0) {
    yield {
      type: 'skip',
      path: '',
      size: 0,
      reason: 'scan-skip-overflow',
      message: `${buffer.dropped} scanner skip event(s) were omitted after ${MAX_BUFFERED_SCAN_EVENTS} buffered diagnostics`,
    }
    buffer.dropped = 0
  }
}

async function resolveContainedLocalPath(
  root: string,
  relativePath: string,
  absolutePath?: string,
): Promise<string> {
  if (root === '') {
    throw new Error('Local sync root required for filesystem mutation')
  }

  const { resolve, sep } = await import('node:path')
  const safeRoot = resolve(root)
  const target =
    absolutePath === undefined ? resolve(safeRoot, relativePath) : resolve(absolutePath)

  if (target !== safeRoot && !target.startsWith(`${safeRoot}${sep}`)) {
    throw new Error(`Refusing to access path outside sync root: ${relativePath}`)
  }

  return target
}
