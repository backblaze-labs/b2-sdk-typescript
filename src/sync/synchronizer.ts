import type { Bucket } from '../bucket.ts'
import type { SseCDownloadKey } from '../raw/index.ts'
import { assertFileSourceMatchesIdentity, FileSource } from '../streams/source.ts'
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
import { localFilesystemErrorReason } from './filesystem-errors.ts'
import { deleteLocalFileInsideRoot, writeLocalStreamInsideRoot } from './local-file-io.ts'
import { isLocalFilesystemRoot } from './local-filesystem-root.ts'
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
import { asRawB2KeyPrefix, b2KeyToRelativePathUnderPrefix } from './prefix.ts'
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
  SyncPath,
  SyncScanOptions,
  SyncSkipEvent,
} from './types.ts'

const MAX_BUFFERED_SCAN_EVENTS = 100
const MAX_AGGREGATE_FAILED_PATHS = 100
const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MILLIS = 60_000

interface ScanEventBuffer {
  readonly events: SyncEvent[]
  fatalFilesystemErrorMessage?: string
  sourceInventoryIncompleteMessage?: string
  dropped: number
}

/**
 * Test hooks for bounded planning behavior.
 *
 * @internal
 */
export const synchronizerTestHooks: {
  afterNonSha1PlanBatch?: (batchSize: number) => void
} = {}

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
  /** Raw B2 key prefix represented by this folder when known. */
  readonly rawPrefix?: string
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

/** Configuration for a B2-to-B2 sync (copy direction). */
export interface SynchronizerB2Config extends SynchronizerConfig {
  /** B2 source folder. */
  readonly source: B2SyncFolder
  /** B2 destination folder. */
  readonly dest: B2SyncFolder
  /** The B2 bucket used for copy, hide, and delete operations. */
  readonly bucket: Bucket
  /**
   * Key prefix for destination-side copy, hide, and delete mutations.
   *
   * When omitted, the synchronizer uses `dest.rawPrefix` when the destination
   * folder exposes one. Set this explicitly for custom B2 folders that do not
   * expose their raw prefix.
   */
  readonly prefix?: string
}

/** Concrete sync configurations supported by {@link synchronize}. */
export type SupportedSynchronizerConfig =
  | SynchronizerUpConfig
  | SynchronizerDownConfig
  | SynchronizerB2Config

interface PreparedActionPlan {
  readonly event: SyncEvent
  readonly actions: readonly SyncAction[]
}

interface LocalRootContexts {
  readonly source?: string
  readonly dest?: string
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
 *
 * @returns An async generator that yields comparison and action events.
 */
export function synchronize(config: SupportedSynchronizerConfig): AsyncGenerator<SyncEvent>
export function synchronize(config: SynchronizerConfig): AsyncGenerator<SyncEvent>
export async function* synchronize(config: SynchronizerConfig): AsyncGenerator<SyncEvent> {
  const { source, dest, options } = config
  assertSupportedCompareMode(options.compareMode)
  const direction = resolveDirection(source, dest)
  const dryRun = options.dryRun ?? false
  const concurrency = normalizeSyncConcurrency(options.concurrency)
  const keepDays = options.keepDays ?? 0
  const compareThreshold = options.compareThreshold ?? 0
  const nowMillis = Date.now()
  const localRootContexts = await resolveLocalRootContexts(config)
  const queuedEvents: SyncEvent[] = []
  const failedPaths: string[] = []
  const failedPathSet = new Set<string>()
  let errorCount = 0
  let failedPathOmittedCount = 0
  let scanHadError = false
  const runningActions = new Set<Promise<void>>()
  const scanEvents: ScanEventBuffer = { events: [], dropped: 0 }
  const scanOptions: SyncScanOptions = {
    ...(options.include !== undefined ? { include: options.include } : {}),
    ...(options.exclude !== undefined ? { exclude: options.exclude } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.maxScanEntries !== undefined ? { maxScanEntries: options.maxScanEntries } : {}),
    ...(direction === 'b2-to-local' ? { requireLocalSafePaths: true } : {}),
    onError: (event) => {
      scanHadError = true
      recordSyncError(event)
      queueEvent(event)
    },
  }

  const factory = createActionFactory(config, localRootContexts)
  const readB2Sha1 = dryRun ? undefined : createB2Sha1Reader(config)
  const actionAbortController = new AbortController()
  const removeAbortForwarder = forwardAbortSignal(options.signal, actionAbortController)
  let completed = false

  async function* finishAfterAbort(): AsyncGenerator<SyncEvent> {
    await drainActions()
    yield* emitQueuedEvents()
  }

  try {
    let pairs: SyncPair[]
    try {
      pairs = await collectPairs()
    } catch (err) {
      await drainActions()
      if (options.signal?.aborted) {
        yield* finishAfterAbort()
        return
      }
      if (!scanHadError) {
        yield* emitQueuedEvents()
        throw err
      }

      yield* emitQueuedEvents()
      yield aggregateErrorEvent()
      completed = true
      return
    }

    yield* emitQueuedEvents()
    const filesystemError = scanFilesystemError(scanEvents)
    if (filesystemError !== undefined) throw filesystemError

    if (options.signal?.aborted) {
      yield* finishAfterAbort()
      return
    }

    if (scanHadError) {
      if (errorCount > 0) yield aggregateErrorEvent()
      completed = true
      return
    }

    if (options.compareMode === 'sha1') {
      const compareBatchSize = concurrency
      for (let index = 0; index < pairs.length; index += compareBatchSize) {
        if (yield* emitSha1Batch(pairs.slice(index, index + compareBatchSize))) return
      }
    } else {
      for (let index = 0; index < pairs.length; index += concurrency) {
        const items = pairs
          .slice(index, index + concurrency)
          .map((pair) => planPreparedPair(pair, readyComparePair(pair)))
        synchronizerTestHooks.afterNonSha1PlanBatch?.(items.length)
        if (yield* emitPreparedItems(items)) return
      }
    }

    await drainActions()
    yield* emitQueuedEvents()

    if (errorCount > 0) {
      yield aggregateErrorEvent()
    }
    completed = true
  } finally {
    if (!completed) {
      abortActionController(
        actionAbortController,
        new DOMException('Sync iterator closed', 'AbortError'),
      )
    }
    removeAbortForwarder()
    await drainActions()
  }

  async function collectPairs(): Promise<SyncPair[]> {
    const pairs: SyncPair[] = []
    for await (const pair of zipFolders(source, dest, scanOptions, {
      onSourceSkip(event) {
        bufferScanEvent(scanEvents, event, direction, 'source')
      },
      onDestSkip(event) {
        bufferScanEvent(scanEvents, event, direction, 'dest')
      },
    })) {
      if (options.signal?.aborted) return pairs
      validateB2SourcePairPrefix(pair, config)
      pairs.push(pair)
    }
    return pairs
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
      yield* emitQueuedEvents()
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

    let preparedErrorEventCount = 0
    for (const preparedEvent of prepared.events) {
      queueEvent(preparedEvent)
      if (preparedEvent.type === 'error') {
        preparedErrorEventCount++
        recordFailurePath(preparedEvent.path)
      }
    }
    errorCount += prepared.errors.length
    for (let index = preparedErrorEventCount; index < prepared.errors.length; index++) {
      recordFailurePath(event.path)
    }
    if (prepared.skipActionGeneration) return { event, actions: [] }
    if (
      (scanHadError || scanHadFilesystemError(scanEvents)) &&
      prepared.pair[0] === null &&
      prepared.pair[1] !== null
    ) {
      return {
        event,
        actions: [
          new SkipAction(prepared.pair[1].relativePath, 'not removed because scan errors occurred'),
        ],
      }
    }
    if (
      sourceInventoryIncomplete(scanEvents) &&
      prepared.pair[0] === null &&
      prepared.pair[1] !== null
    ) {
      return {
        event,
        actions: [
          new SkipAction(
            prepared.pair[1].relativePath,
            scanEvents.sourceInventoryIncompleteMessage ??
              'not removed because the source scan skipped unsafe B2 names',
          ),
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
      if (actionAbortController.signal.aborted) return
      const event = await action.execute(dryRun, actionAbortController.signal)
      queueEvent(event)
    } catch (err) {
      const event: SyncEvent = {
        type: 'error',
        path: action.relativePath,
        size: 0,
        message: sanitizeErrorReason(err),
      }
      recordSyncError(event)
      queueEvent(event)
    }
  }

  function recordSyncError(event: SyncEvent): void {
    errorCount += 1
    recordFailurePath(event.path)
  }

  function recordFailurePath(path: string): void {
    if (path === '') return
    if (failedPathSet.has(path)) return
    failedPathSet.add(path)
    if (failedPaths.length < MAX_AGGREGATE_FAILED_PATHS) {
      failedPaths.push(path)
    } else {
      failedPathOmittedCount++
    }
  }

  function aggregateErrorEvent(): SyncEvent {
    return {
      type: 'error',
      path: '',
      size: 0,
      message: `${errorCount} sync error(s) occurred`,
      failureCount: errorCount,
      failedPaths: [...failedPaths],
      ...(failedPathOmittedCount > 0 ? { failedPathOmittedCount } : {}),
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
 *
 * @throws When the configured concurrency is not a positive integer.
 */
function normalizeSyncConcurrency(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TRANSFER_CONCURRENCY
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new RangeError('Sync concurrency must be a positive integer')
  }
  return candidate
}

function normalizeDownloadIdleTimeoutMillis(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MILLIS
  if (value === Number.POSITIVE_INFINITY) return value
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError('downloadIdleTimeoutMillis must be a positive finite number or Infinity')
  }
  return Math.floor(value)
}

function assertValidB2ContentLength(contentLength: number): number {
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error('B2 contentLength must be a non-negative safe integer')
  }
  return contentLength
}

function createB2Sha1Reader(config: SynchronizerConfig): B2Sha1Reader | undefined {
  const upConfig = config as Partial<SynchronizerUpConfig>
  const downConfig = config as Partial<SynchronizerDownConfig>
  const bucket = upConfig.bucket ?? downConfig.bucket
  if (bucket === undefined) return undefined
  const readablePrefixes = b2ReadableRawPrefixes(config)
  const idleTimeoutMillis = normalizeSha1TimeoutMillis(config.options.sha1ReadTimeoutMillis)
  const verificationTimeoutMillis = normalizeSha1TimeoutMillis(
    config.options.sha1VerificationTimeoutMillis,
    DEFAULT_SHA1_VERIFICATION_TIMEOUT_MILLIS,
  )

  return async (path, signal) => {
    const expectedBytes = assertValidB2ContentLength(path.selectedVersion.contentLength)
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
        const fileName = validateB2SyncPathInAnyPrefix(readablePrefixes, path, 'read')
        const result = await bucket.file(fileName).downloadById(path.selectedVersion.fileId, {
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

function forwardAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (source === undefined) return () => undefined
  if (source.aborted) {
    abortActionController(controller, source.reason)
    return () => undefined
  }

  const abort = () => abortActionController(controller, source.reason)
  source.addEventListener('abort', abort, { once: true })
  return () => source.removeEventListener('abort', abort)
}

function abortActionController(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) {
    controller.abort(reason)
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
 * Returns the root for a local sync folder required by an action.
 *
 * @param folder - The configured folder to validate.
 * @param role - Whether the local folder is the source or destination.
 * @param context - Short verb describing the action being constructed.
 *
 * @returns The local filesystem root.
 *
 * @throws `Error` when the folder is not local or has no root.
 */
function requireLocalRoot(
  folder: SyncFolder | undefined,
  role: 'source' | 'destination',
  context: string,
): string {
  const root = folder?.type === 'local' ? (folder as Partial<LocalSyncFolder>).root : undefined
  if (typeof root !== 'string' || root === '') {
    throw new Error(`Local ${role} root required for ${context} actions`)
  }
  return root
}

async function resolveLocalRootContexts(config: SynchronizerConfig): Promise<LocalRootContexts> {
  if (config.source.type !== 'local' && config.dest.type !== 'local') return {}

  const path = await import('node:path')
  const sourceContext = config.dest.type === 'b2' ? 'upload' : 'sync'
  const destContext = config.source.type === 'b2' ? 'download' : 'sync'
  return {
    ...(isLocalFilesystemFolder(config.source)
      ? { source: path.resolve(requireLocalRoot(config.source, 'source', sourceContext)) }
      : {}),
    ...(isLocalFilesystemFolder(config.dest)
      ? { dest: path.resolve(requireLocalRoot(config.dest, 'destination', destContext)) }
      : {}),
  }
}

function isLocalFilesystemFolder(folder: SyncFolder | undefined): folder is LocalSyncFolder {
  return folder?.type === 'local' && isLocalFilesystemRoot(folder)
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
 * @param config - Synchronizer configuration containing source, destination, and options.
 * @param localRootContexts - Resolved filesystem roots captured before action creation.
 *
 * @returns An action factory bound to the provided configuration.
 */
function createActionFactory(
  config: SynchronizerConfig,
  localRootContexts: LocalRootContexts,
): ActionFactory {
  const upConfig = config as Partial<SynchronizerUpConfig>
  const downConfig = config as Partial<SynchronizerDownConfig>
  const uploadPrefix = asRawB2KeyPrefix(upConfig.prefix ?? b2FolderRawPrefix(config.dest) ?? '')
  const sourceB2Prefix = b2FolderRawPrefix(config.source)

  const destBucket = upConfig.bucket ?? downConfig.bucket
  // Defensive optional chain on `info`: synchronizer tests use Bucket
  // mocks that don't populate this field. Real `Bucket` instances always
  // do (constructor parameter).
  const bucketIsLocked = destBucket?.info?.fileLockConfiguration?.value?.isFileLockEnabled ?? false

  const factory: ActionFactory = {
    upload(source: LocalSyncPath, dest?: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket
      assertBucket(bucket, 'upload')

      return new UploadAction(
        source.relativePath,
        source.absolutePath,
        source.size,
        async (absPath, relPath, signal) => {
          const root =
            localRootContexts.source ?? (upConfig.source as Partial<LocalSyncFolder>).root ?? ''
          const fileName =
            dest !== undefined
              ? validateB2SyncPathInPrefix(uploadPrefix, dest)
              : `${uploadPrefix}${relPath}`
          const fileSource = await createContainedScannedFileSource(
            root,
            { ...source, absolutePath: absPath },
            signal,
          )
          throwIfAborted(signal)
          const serverSideEncryption = config.options.encryptionProvider?.getSettingForUpload(
            fileName,
            fileSource.size,
          )
          await bucket.upload({
            fileName,
            source: fileSource,
            ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
            ...(signal !== undefined ? { signal } : {}),
          })
        },
      )
    },

    download(source: B2SyncPath, scannedDest?: LocalSyncPath | null): SyncAction {
      const bucket = downConfig.bucket
      assertBucket(bucket, 'download')

      return new DownloadAction(source.relativePath, source.size, async (relPath, signal) => {
        const root =
          localRootContexts.dest ?? (downConfig.dest as Partial<LocalSyncFolder>).root ?? ''
        safeRelativePathSegments(relPath)
        const b2FileName =
          sourceB2Prefix === undefined
            ? source.selectedVersion.fileName
            : validateB2SyncPathInPrefix(sourceB2Prefix, source, 'read')
        const idleTimeoutMillis = normalizeDownloadIdleTimeoutMillis(
          config.options.downloadIdleTimeoutMillis,
        )
        const expectedBytes = assertValidB2ContentLength(source.selectedVersion.contentLength)
        await ensureLocalSyncRootDirectory(root, relPath)
        const serverSideEncryption = toSseCDownloadKey(
          config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
        )
        const result = await bucket.file(b2FileName).downloadById(source.selectedVersion.fileId, {
          ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
          ...(signal !== undefined ? { signal } : {}),
        })
        try {
          await writeLocalStreamInsideRoot(root, relPath, result.body, {
            expectedBytes,
            ...(scannedDest !== undefined ? { expectedDestination: scannedDest } : {}),
            idleTimeoutMillis,
            ...(signal !== undefined ? { signal } : {}),
          })
        } catch (err) {
          await cancelReadableStreamBody(result.body, err)
          throw err
        }
      })
    },

    copy(source: B2SyncPath, destRelativePath: string): SyncAction {
      return copyToB2Key(source, `${uploadPrefix}${destRelativePath}`)
    },

    copyB2Path(source: B2SyncPath, dest: B2SyncPath): SyncAction {
      return copyToB2Key(source, validateB2SyncPathInPrefix(uploadPrefix, dest))
    },

    hide(path: string): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      assertBucket(bucket, 'hide')

      return new HideAction(path, async (_relPath, signal) => {
        await bucket.hideFile(
          `${uploadPrefix}${path}`,
          signal === undefined ? undefined : { signal },
        )
      })
    },

    hideB2Path(path: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      assertBucket(bucket, 'hide')
      const b2FileName = validateB2SyncPathInPrefix(uploadPrefix, path)

      return new HideAction(path.relativePath, async (_relPath, signal) => {
        await bucket.hideFile(b2FileName, signal === undefined ? undefined : { signal })
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
      const b2FileName = validateB2SyncPathInPrefix(uploadPrefix, path)
      return new DeleteRemoteAction(
        path.relativePath,
        path.selectedVersion.fileId as string,
        async (fileId, _fileName, signal) => {
          await bucket.deleteFileVersion(
            b2FileName,
            fileIdOf(fileId),
            signal === undefined ? undefined : { signal },
          )
        },
      )
    },

    deleteLocal(path: LocalSyncPath): SyncAction {
      const root = localRootContexts.dest ?? localSyncRoot(downConfig.dest)
      return new DeleteLocalAction(
        path.relativePath,
        path.absolutePath,
        async (absPath, signal) => {
          signal?.throwIfAborted()
          if (absPath !== path.absolutePath) {
            throw new Error(`Refusing to delete outside sync root: ${path.relativePath}`)
          }
          signal?.throwIfAborted()
          try {
            await deleteLocalFileInsideRoot(root, path)
          } catch (err) {
            if (isLocalDeleteSafetyError(err)) throw err
            throw new Error(`failed to delete local file: ${localFilesystemErrorReason(err)}`)
          }
        },
      )
    },

    removeOrphan(dest: B2SyncPath): SyncAction {
      // Locked buckets: `b2_delete_file_version` is blocked or stacks
      // hide markers under retention; a hide is the safe choice.
      // Vanilla buckets: plain delete is the right move — hide markers
      // would just litter the version history.
      return bucketIsLocked
        ? (factory.hideB2Path?.(dest) ?? factory.hide(dest.relativePath))
        : factory.deleteRemote(dest)
    },
  }

  function copyToB2Key(source: B2SyncPath, targetPath: string): SyncAction {
    const bucket = upConfig.bucket
    assertBucket(bucket, 'copy')

    return new CopyAction(source.relativePath, source.size, async (_relPath, signal) => {
      if (sourceB2Prefix !== undefined) validateB2SyncPathInPrefix(sourceB2Prefix, source, 'read')
      const destinationServerSideEncryption =
        config.options.encryptionProvider?.getSettingForUpload(targetPath, source.size)
      const sourceServerSideEncryption = toSseCEncryptionSetting(
        config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
      )
      await bucket.copyFile({
        sourceFileId: source.selectedVersion.fileId,
        fileName: targetPath,
        ...(destinationServerSideEncryption !== undefined
          ? { destinationServerSideEncryption }
          : {}),
        ...(sourceServerSideEncryption !== undefined ? { sourceServerSideEncryption } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    })
  }

  return factory
}

function localSyncRoot(folder: LocalSyncFolder | undefined): string {
  return folder?.type === 'local' ? folder.root : ''
}

function b2FolderRawPrefix(folder: SyncFolder | undefined): string | undefined {
  if (folder?.type !== 'b2') return undefined
  const rawPrefix = (folder as B2SyncFolder).rawPrefix
  return typeof rawPrefix === 'string' ? rawPrefix : undefined
}

function validateB2SourcePairPrefix(pair: SyncPair, config: SynchronizerConfig): void {
  const [source] = pair
  if (config.source.type !== 'b2' || source === null || !isB2SyncPath(source)) return
  const sourcePrefix = b2FolderRawPrefix(config.source)
  if (sourcePrefix === undefined) return
  validateB2SyncPathInPrefix(sourcePrefix, source, 'read')
}

function b2ReadableRawPrefixes(config: SynchronizerConfig): readonly string[] {
  const prefixes: string[] = []
  const sourcePrefix = b2FolderRawPrefix(config.source)
  if (config.source.type === 'b2') prefixes.push(sourcePrefix ?? '')

  const upConfig = config as Partial<SynchronizerUpConfig>
  if (config.dest.type === 'b2') {
    prefixes.push(upConfig.prefix ?? b2FolderRawPrefix(config.dest) ?? '')
  }

  return [...new Set(prefixes.map((prefix) => asRawB2KeyPrefix(prefix)))]
}

function validateB2SyncPathInAnyPrefix(
  prefixes: readonly string[],
  path: B2SyncPath,
  operation: string,
): string {
  let firstError = new Error(`Refusing to ${operation} B2 key: ${path.relativePath}`)
  for (const prefix of prefixes) {
    try {
      return validateB2SyncPathInPrefix(prefix, path, operation)
    } catch (err) {
      if (err instanceof Error) firstError = err
    }
  }
  throw firstError
}

function validateB2SyncPathInPrefix(
  prefix: string,
  path: B2SyncPath,
  operation = 'mutate',
): string {
  const fileName = path.selectedVersion.fileName
  if (!fileName.startsWith(prefix)) {
    throw new Error(
      `Refusing to ${operation} B2 key outside configured prefix: ${path.relativePath}`,
    )
  }

  const relativePath = b2KeyToRelativePathUnderPrefix(prefix, fileName)
  if (relativePath !== path.relativePath) {
    throw new Error(
      `Refusing to ${operation} mismatched B2 key for sync path: ${path.relativePath}`,
    )
  }

  return fileName
}

function isB2SyncPath(path: SyncPath): path is B2SyncPath {
  return 'selectedVersion' in path
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

async function cancelReadableStreamBody(
  body: ReadableStream<Uint8Array>,
  reason: unknown,
): Promise<void> {
  if (body.locked) return
  try {
    await body.cancel(reason)
  } catch {
    // Best-effort response cleanup must not mask the setup or write failure.
  }
}

async function createContainedScannedFileSource(
  root: string,
  path: LocalSyncPath,
  signal: AbortSignal | undefined,
): Promise<FileSource> {
  const targetPath = await resolveContainedLocalPath(root, path.relativePath, path.absolutePath)
  throwIfAborted(signal)
  await assertScannedLocalFileStillCurrent(targetPath, path)
  throwIfAborted(signal)
  const fileSource = await FileSource.fromPath(targetPath)
  if (path.fileIdentity !== undefined) {
    assertFileSourceMatchesIdentity(fileSource, path.fileIdentity)
  }
  await resolveContainedLocalPath(root, path.relativePath, targetPath)
  await assertScannedLocalFileStillCurrent(targetPath, path)
  throwIfAborted(signal)
  return fileSource
}

async function assertScannedLocalFileStillCurrent(
  targetPath: string,
  path: LocalSyncPath,
): Promise<void> {
  const { lstat } = await import('node:fs/promises')
  const stats = await lstat(targetPath)
  if (!stats.isFile()) throw new Error('local file changed before upload: not a regular file')
  if (stats.size !== path.size) throw new Error('local file changed before upload: size changed')

  const identity = path.fileIdentity
  if (identity === undefined) return
  if (
    stats.dev !== identity.deviceId ||
    stats.ino !== identity.inode ||
    stats.size !== identity.size ||
    Math.floor(stats.mtimeMs) !== identity.modTimeMillis
  ) {
    throw new Error('local file changed before upload')
  }
}

async function ensureLocalSyncRootDirectory(root: string, relativePath: string): Promise<void> {
  if (root === '') {
    throw new Error('Local sync root required for filesystem mutation')
  }

  const { lstat, mkdir } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const safeRoot = resolve(root)

  try {
    const stats = await lstat(safeRoot)
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to access sync root through symlink: ${relativePath}`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`Local sync root is not a directory: ${relativePath}`)
    }
    return
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  await mkdir(safeRoot, { recursive: true })
  await assertLocalRootHasNoSymlink(safeRoot, relativePath)
}

function bufferScanEvent(
  buffer: ScanEventBuffer,
  event: SyncEvent,
  direction: SyncDirection,
  scanSide: 'source' | 'dest',
): void {
  if (event.type === 'skip' && event.reason === 'filesystem-error') {
    buffer.fatalFilesystemErrorMessage ??= event.message
  }
  if (sourceSkipMakesInventoryIncomplete(event, direction, scanSide)) {
    buffer.sourceInventoryIncompleteMessage ??= sourceInventoryIncompleteMessage(direction)
  }
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

function scanHadFilesystemError(scanEvents: ScanEventBuffer): boolean {
  return scanEvents.fatalFilesystemErrorMessage !== undefined
}

function sourceInventoryIncomplete(scanEvents: ScanEventBuffer): boolean {
  return scanEvents.sourceInventoryIncompleteMessage !== undefined
}

function scanFilesystemError(scanEvents: ScanEventBuffer): Error | undefined {
  return scanEvents.fatalFilesystemErrorMessage === undefined
    ? undefined
    : new Error(scanEvents.fatalFilesystemErrorMessage)
}

function sourceSkipMakesInventoryIncomplete(
  event: SyncEvent,
  direction: SyncDirection,
  scanSide: 'source' | 'dest',
): event is SyncSkipEvent {
  if (scanSide !== 'source' || event.type !== 'skip') return false

  if (direction === 'local-to-b2') {
    return (
      event.reason === 'unsafe-name' ||
      event.reason === 'stale-download-partial' ||
      event.reason === 'path-too-long-for-regexp'
    )
  }

  if (direction === 'b2-to-local' || direction === 'b2-to-b2') {
    return (
      event.reason === 'unsafe-name' ||
      event.reason === 'local-unsafe-name' ||
      event.reason === 'relative-path-collision' ||
      event.reason === 'local-path-collision' ||
      event.reason === 'path-too-long-for-regexp'
    )
  }

  return false
}

function sourceInventoryIncompleteMessage(direction: SyncDirection): string {
  return direction === 'local-to-b2'
    ? 'not removed because the source scan skipped local paths'
    : 'not removed because the source scan skipped unsafe B2 names'
}

function isLocalDeleteSafetyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message === 'Local sync root required for filesystem mutation' ||
    err.message.startsWith('Refusing to ') ||
    err.message.startsWith('Local sync root is not a directory: ') ||
    err.message.startsWith('unsafe local delete path: ')
  )
}

async function resolveContainedLocalPath(
  root: string,
  relativePath: string,
  absolutePath?: string,
): Promise<string> {
  if (root === '') {
    throw new Error('Local sync root required for filesystem mutation')
  }

  const { isAbsolute, relative, resolve, sep } = await import('node:path')
  const safeRoot = resolve(root)
  const target =
    absolutePath === undefined ? resolve(safeRoot, relativePath) : resolve(absolutePath)
  const pathFromRoot = relative(safeRoot, target)
  const escapesRoot =
    pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)

  /* v8 ignore next -- defense-in-depth after prior no-follow and symlink checks. */
  if (escapesRoot) {
    throw new Error(`Refusing to access path outside sync root: ${relativePath}`)
  }

  await assertLocalRootHasNoSymlink(safeRoot, relativePath)
  await assertPathHasNoSymlinkComponents(safeRoot, pathFromRoot, relativePath)

  return target
}

async function assertLocalRootHasNoSymlink(safeRoot: string, relativePath: string): Promise<void> {
  const { lstat } = await import('node:fs/promises')
  try {
    const stats = await lstat(safeRoot)
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to access sync root through symlink: ${relativePath}`)
    }
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
}

async function assertPathHasNoSymlinkComponents(
  safeRoot: string,
  pathFromRoot: string,
  relativePath: string,
): Promise<void> {
  if (pathFromRoot === '') return

  const { lstat } = await import('node:fs/promises')
  const { join, sep } = await import('node:path')
  let current = safeRoot

  for (const segment of pathFromRoot.split(sep)) {
    current = join(current, segment)
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(current)
    } catch (error) {
      if (isNotFoundError(error)) return
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to access path through symlink: ${relativePath}`)
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  )
}
