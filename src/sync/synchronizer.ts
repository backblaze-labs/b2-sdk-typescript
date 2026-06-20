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
  SkipAction,
  UploadAction,
} from './actions/index.ts'
import { readLocalSha1File } from './local-sha1.ts'
import { type SyncPair, zipFolders } from './pairing.ts'
import {
  assertSupportedCompareMode,
  type B2Sha1Reader,
  type ComparePreparationResult,
  preparePairsForCompare,
  readyComparePair,
} from './policies/compare.ts'
import type { ActionFactory } from './policies/index.ts'
import { generateActions } from './policies/index.ts'
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
  const readB2Sha1 = dryRun ? undefined : createB2Sha1Reader(config)

  const queuedEvents: SyncEvent[] = []
  let errorCount = 0
  let scanHadError = false
  const runningActions = new Set<Promise<void>>()
  const scanOptions: SyncScanOptions = {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onError: (event) => {
      scanHadError = true
      errorCount += 1
      queueEvent(event)
    },
  }

  async function* finishAfterAbort(): AsyncGenerator<SyncEvent> {
    await drainActions()
    yield* emitQueuedEvents()
  }

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
      const errorValue = toError(err)
      errorCount += 1
      queueEvent({
        type: 'error',
        path: action.relativePath,
        size: 0,
        message: errorValue.message,
      })
    }
  }

  function queueEvent(event: SyncEvent): void {
    queuedEvents.push(event)
  }

  async function* emitQueuedEvents(): AsyncGenerator<SyncEvent> {
    for (const event of queuedEvents.splice(0)) yield event
  }

  async function drainActions(): Promise<void> {
    while (runningActions.size > 0) {
      await Promise.race(runningActions)
    }
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
    const maxBytes = normalizeSha1VerificationMaxBytes(
      path.selectedVersion.contentLength,
      config.options.sha1VerificationMaxBytes,
    )
    return withSha1VerificationDeadline(
      signal,
      verificationTimeoutMillis,
      async (deadlineSignal) => {
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
          expectedBytes: path.selectedVersion.contentLength,
        })
        return { contentSha1: verified.contentSha1, bytesRead: verified.bytesRead }
      },
    )
  }
}

async function hashReadableStreamSha1(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options?: {
    readonly idleTimeoutMillis: number
    readonly maxBytes: number
    readonly expectedBytes: number
  },
): Promise<{ readonly contentSha1: string; readonly bytesRead: number }> {
  const hash = new IncrementalSha1()
  const reader = body.getReader()
  const idleTimeoutMillis = options?.idleTimeoutMillis ?? normalizeSha1TimeoutMillis(undefined)
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY
  const expectedBytes = options?.expectedBytes
  let bytesRead = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await readStreamChunkWithTimeout(reader, idleTimeoutMillis)
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) {
        throw new Error(`sha1 B2 read exceeded ${maxBytes} byte verification budget`)
      }
      await hash.update(value)
    }
    if (expectedBytes !== undefined && bytesRead !== expectedBytes) {
      throw new Error(`sha1 B2 read ended after ${bytesRead} bytes, expected ${expectedBytes}`)
    }
    return { contentSha1: await hash.digest(), bytesRead }
  } catch (err) {
    void reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
}

async function withSha1VerificationDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMillis: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromParent()
  signal?.addEventListener('abort', abortFromParent, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new Error(`sha1 B2 verification exceeded ${timeoutMillis} ms`))
      reject(new Error(`sha1 B2 verification exceeded ${timeoutMillis} ms`))
    }, timeoutMillis)
  })
  const runPromise = run(controller.signal)
  try {
    return await Promise.race([runPromise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    signal?.removeEventListener('abort', abortFromParent)
    void runPromise.catch(() => {})
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

function normalizeSha1VerificationMaxBytes(
  contentLength: number,
  ceiling: number | undefined,
): number {
  const contentBudget = Math.max(0, Math.floor(contentLength))
  if (ceiling === undefined) return contentBudget
  if (!Number.isFinite(ceiling) || ceiling < 0) return contentBudget
  return Math.min(contentBudget, Math.floor(ceiling))
}

async function readScannedLocalFile(path: LocalSyncPath): Promise<Uint8Array> {
  const { constants } = await import('node:fs')
  const { open } = await import('node:fs/promises')
  const handle = await open(path.absolutePath, constants.O_RDONLY | noFollowFlag(constants)).catch(
    (err: unknown) => {
      if (hasErrorCode(err, 'ELOOP')) {
        throw new Error('local file changed before upload: not a regular file')
      }
      throw new Error('local file changed before upload: could not open scanned file')
    },
  )
  try {
    const stats = await handle.stat()
    assertSameScannedRegularFile(stats, path)
    const data = await handle.readFile()
    if (data.byteLength !== path.size) {
      throw new Error('local file changed before upload: size changed while reading')
    }
    return new Uint8Array(data)
  } finally {
    await handle.close()
  }
}

function assertSameScannedRegularFile(
  stats: {
    isFile(): boolean
    readonly dev: number
    readonly ino: number
    readonly mtimeMs: number
    readonly size: number
  },
  path: LocalSyncPath,
): void {
  if (!stats.isFile()) {
    throw new Error('local file changed before upload: not a regular file')
  }
  if (stats.size !== path.size) {
    throw new Error('local file changed before upload: size changed')
  }

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

async function writeLocalFileInsideRoot(
  root: string,
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  const { constants } = await import('node:fs')
  const { lstat, mkdir, open, realpath } = await import('node:fs/promises')
  const path = await import('node:path')
  const segments = safeRelativePathSegments(relPath)
  const rootRealPath = await realpath(root)

  let current = rootRealPath
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    try {
      await mkdir(current)
    } catch (err) {
      if (!hasErrorCode(err, 'EEXIST')) throw err
    }
    const stats = await lstat(current)
    if (!stats.isDirectory()) {
      throw new Error('unsafe local destination path: parent is not a directory')
    }
  }

  const destPath = path.join(rootRealPath, ...segments)
  assertPathInsideRoot(rootRealPath, destPath, path)
  const handle = await open(
    destPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollowFlag(constants),
    0o666,
  )
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

function safeRelativePathSegments(relPath: string): string[] {
  if (
    relPath.length === 0 ||
    relPath.includes('\0') ||
    relPath.includes('\\') ||
    relPath.startsWith('/') ||
    /^[A-Za-z]:/.test(relPath)
  ) {
    throw new Error('unsafe local destination path')
  }

  const segments = relPath.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('unsafe local destination path')
  }
  return segments
}

function assertPathInsideRoot(
  root: string,
  target: string,
  path: typeof import('node:path'),
): void {
  const relative = path.relative(root, target)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('unsafe local destination path')
  }
}

function noFollowFlag(constants: { readonly O_NOFOLLOW?: number }): number {
  return constants.O_NOFOLLOW ?? 0
}

function hasErrorCode(err: unknown, code: string): boolean {
  return (err as { readonly code?: unknown }).code === code
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
          const data = await readScannedLocalFile({ ...source, absolutePath: absPath })
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
        safeRelativePathSegments(relPath)
        const serverSideEncryption = toSseCDownloadKey(
          config.options.encryptionProvider?.getSettingForDownload(source.selectedVersion),
        )
        const result = await bucket
          .file(source.selectedVersion.fileName)
          .downloadById(source.selectedVersion.fileId, {
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

        await writeLocalFileInsideRoot(root, relPath, combined)
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
