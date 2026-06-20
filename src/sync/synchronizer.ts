import type { Bucket } from '../bucket.ts'
import type { SseCDownloadKey } from '../raw/index.ts'
import { IncrementalSha1 } from '../streams/hash.ts'
import { BufferSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import { fileId as fileIdOf } from '../types/ids.ts'
import { DEFAULT_TRANSFER_CONCURRENCY } from '../util/defaults.ts'
import { toError } from '../util/to-error.ts'
import type { SyncAction } from './actions/index.ts'
import {
  CopyAction,
  DeleteLocalAction,
  DeleteRemoteAction,
  DownloadAction,
  HideAction,
  UploadAction,
} from './actions/index.ts'
import { readLocalSha1File } from './local-sha1.ts'
import { type SyncPair, zipFolders } from './pairing.ts'
import {
  assertSupportedCompareMode,
  type B2Sha1Reader,
  preparePairsForCompare,
  readyComparePair,
} from './policies/compare.ts'
import type { ActionFactory } from './policies/index.ts'
import { generateActions } from './policies/index.ts'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncDirection,
  SyncEvent,
  SyncFolder,
  SyncOptions,
  SyncScanOptions,
} from './types.ts'

const DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS = 30_000

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
  /** Key prefix for uploaded files in the bucket. */
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this generator keeps scan, compare, scheduling, and terminal events in one ordered flow.
export async function* synchronize(config: SynchronizerConfig): AsyncGenerator<SyncEvent> {
  const { source, dest, options } = config
  assertSupportedCompareMode(options.compareMode)
  const direction = resolveDirection(source, dest)
  const dryRun = options.dryRun ?? false
  const concurrency = normalizeSyncConcurrency(options.concurrency)
  const keepDays = options.keepDays ?? 0
  const compareThreshold = options.compareThreshold ?? 0
  const nowMillis = Date.now()

  const factory = createActionFactory(config)
  const readB2Sha1 = createB2Sha1Reader(config)

  const results: SyncEvent[] = []
  const errors: Error[] = []
  const scanEvents: SyncEvent[] = []
  const runningActions = new Set<Promise<void>>()
  const scanOptions: SyncScanOptions = {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onError: (event) => {
      scanEvents.push(event)
    },
  }

  try {
    if (options.compareMode === 'sha1') {
      const compareBatchSize = concurrency
      let batch: SyncPair[] = []
      for await (const pair of zipFolders(source, dest, scanOptions)) {
        if (options.signal?.aborted) return
        batch.push(pair)
        if (batch.length >= compareBatchSize) {
          const preparedBatch = await processPreparedBatch(batch)
          for (const item of preparedBatch.items) {
            yield item.event
            /* v8 ignore next -- abort between compare yield and scheduling is timing-dependent */
            if (options.signal?.aborted) return
            for (const action of item.actions) await scheduleAction(action)
          }
          /* v8 ignore next -- batch preparation abort races are covered through lower-level tests */
          if (preparedBatch.aborted) return
          batch = []
        }
      }

      const preparedBatch = await processPreparedBatch(batch)
      for (const item of preparedBatch.items) {
        yield item.event
        if (options.signal?.aborted) return
        for (const action of item.actions) await scheduleAction(action)
      }
      if (preparedBatch.aborted) return
    } else {
      for await (const pair of zipFolders(source, dest, scanOptions)) {
        if (options.signal?.aborted) return
        const item = planPreparedPair(pair, readyComparePair(pair))
        yield item.event
        if (options.signal?.aborted) return
        for (const action of item.actions) await scheduleAction(action)
      }
    }
  } catch (err) {
    if (scanEvents.length === 0) throw err

    await drainActions()
    const errorValue = toError(err)
    errors.push(errorValue)
    for (const event of results) yield event
    for (const event of scanEvents) yield event
    yield {
      type: 'error',
      path: '',
      size: 0,
      message: `${errors.length} sync error(s) occurred`,
    }
    return
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
    prepared: ReturnType<typeof readyComparePair>,
  ): PreparedActionPlan {
    const event: SyncEvent = {
      type: 'compare',
      path: (pair[0] ?? pair[1])?.relativePath ?? '',
      size: 0,
      bytesHashed: prepared.bytesHashed,
    }

    results.push(...prepared.events)
    errors.push(...prepared.errors)
    if (prepared.skipActionGeneration) return { event, actions: [] }

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
      results.push(event)
    } catch (err) {
      const errorValue = toError(err)
      errors.push(errorValue)
      results.push({
        type: 'error',
        path: action.relativePath,
        size: 0,
        message: errorValue.message,
      })
    }
  }

  async function drainActions(): Promise<void> {
    while (runningActions.size > 0) {
      await Promise.race(runningActions)
    }
  }

  await drainActions()

  for (const event of results) {
    yield event
  }

  if (errors.length > 0) {
    yield {
      type: 'error',
      path: '',
      size: 0,
      message: `${errors.length} sync error(s) occurred`,
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
  const timeoutMillis = normalizeSha1ReadTimeout(config.options.sha1ReadTimeoutMillis)

  return async (path, signal) => {
    const serverSideEncryption = toSseCDownloadKey(
      config.options.encryptionProvider?.getSettingForDownload(path.selectedVersion),
    )
    const result = await bucket
      .file(path.selectedVersion.fileName)
      .downloadById(path.selectedVersion.fileId, {
        ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
    return hashReadableStreamSha1(result.body, signal, timeoutMillis)
  }
}

async function hashReadableStreamSha1(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  timeoutMillis = DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS,
): Promise<string> {
  const hash = new IncrementalSha1()
  const reader = body.getReader()
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await readStreamChunkWithTimeout(reader, timeoutMillis)
      if (done) break
      await hash.update(value)
    }
    return hash.digest()
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMillis: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const readPromise = reader.read()
  try {
    return await Promise.race([
      readPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`sha1 B2 read stalled for ${timeoutMillis} ms`))
        }, timeoutMillis)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    void readPromise.catch(() => {})
  }
}

function normalizeSha1ReadTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS
  }
  return Math.floor(value)
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
    upload(source: LocalSyncPath): SyncAction {
      const bucket = upConfig.bucket
      const prefix = upConfig.prefix ?? ''
      assertBucket(bucket, 'upload')

      return new UploadAction(
        source.relativePath,
        source.absolutePath,
        source.size,
        async (absPath, relPath) => {
          const { readFile } = await import('node:fs/promises')
          const data = await readFile(absPath)
          const fileName = `${prefix}${relPath}`
          const serverSideEncryption = config.options.encryptionProvider?.getSettingForUpload(
            fileName,
            data.byteLength,
          )
          await bucket.upload({
            fileName,
            source: new BufferSource(new Uint8Array(data)),
            ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
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
        const serverSideEncryption = toSseCDownloadKey(
          config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
        )
        const result = await bucket.download(source.selectedVersion.fileName, {
          ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
        })
        const reader = result.body.getReader()
        let combined: Uint8Array
        try {
          const chunks: Uint8Array[] = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
          }
          let total = 0
          for (const c of chunks) total += c.byteLength
          combined = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            combined.set(c, offset)
            offset += c.byteLength
          }
        } finally {
          // Release the body stream's reader lock so a downstream
          // writeFile failure doesn't strand the response stream half-
          // open with the upstream HTTP connection still pumping.
          reader.releaseLock()
        }

        const { mkdir, writeFile } = await import('node:fs/promises')
        const { dirname, join } = await import('node:path')
        const destPath = join(root, relPath)
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, combined)
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
        })
      })
    },

    hide(path: string): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      assertBucket(bucket, 'hide')

      return new HideAction(path, async (relPath) => {
        const prefix = upConfig.prefix ?? ''
        await bucket.hideFile(`${prefix}${relPath}`)
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
          await bucket.deleteFileVersion(b2FileName, fileIdOf(fileId))
        },
      )
    },

    deleteLocal(path: LocalSyncPath): SyncAction {
      return new DeleteLocalAction(path.relativePath, path.absolutePath, async (absPath) => {
        const { unlink } = await import('node:fs/promises')
        await unlink(absPath)
      })
    },

    removeOrphan(dest: B2SyncPath): SyncAction {
      // Locked buckets: `b2_delete_file_version` is blocked or stacks
      // hide markers under retention; a hide is the safe choice.
      // Vanilla buckets: plain delete is the right move — hide markers
      // would just litter the version history.
      return bucketIsLocked ? factory.hide(dest.relativePath) : factory.deleteRemote(dest)
    },
  }

  return factory
}
