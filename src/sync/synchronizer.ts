import type { Bucket } from '../bucket.ts'
import type { SseCDownloadKey } from '../raw/index.ts'
import { BufferSource } from '../streams/source.ts'
import type { EncryptionSetting } from '../types/encryption.ts'
import { fileId as fileIdOf } from '../types/ids.ts'
import { Semaphore } from '../upload/concurrency.ts'
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
import { zipFolders } from './pairing.ts'
import type { ActionFactory } from './policies/index.ts'
import { generateActions } from './policies/index.ts'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncDirection,
  SyncEvent,
  SyncFolder,
  SyncOptions,
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
  const direction = resolveDirection(source, dest)
  const dryRun = options.dryRun ?? false
  const concurrency = options.concurrency ?? DEFAULT_TRANSFER_CONCURRENCY
  const keepDays = options.keepDays ?? 0
  const compareThreshold = options.compareThreshold ?? 0
  const nowMillis = Date.now()

  const factory = createActionFactory(config)

  const actions: SyncAction[] = []

  for await (const pair of zipFolders(source, dest)) {
    if (options.signal?.aborted) return

    for (const action of generateActions(
      pair,
      direction,
      options.compareMode,
      options.keepMode,
      keepDays,
      nowMillis,
      factory,
      compareThreshold,
    )) {
      actions.push(action)
    }

    yield { type: 'compare', path: (pair[0] ?? pair[1])?.relativePath ?? '', size: 0 }
  }

  const sem = new Semaphore(concurrency)
  const results: SyncEvent[] = []
  const errors: Error[] = []

  const promises = actions.map(async (action) => {
    await sem.acquire()
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
    } finally {
      sem.release()
    }
  })

  await Promise.all(promises)

  for (const event of results) {
    yield event
  }

  if (errors.length > 0) {
    yield {
      type: 'error',
      path: '',
      size: 0,
      message: `${errors.length} action(s) failed`,
    }
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

/** Narrows a setting to SSE-C; non-SSE-C source settings need no key on read. */
function toSseCEncryptionSetting(
  setting: EncryptionSetting | undefined,
): Extract<EncryptionSetting, { readonly mode: 'SSE-C' }> | undefined {
  if (setting?.mode !== 'SSE-C') return undefined
  return setting
}

/** Builds a download key from SSE-C settings; non-SSE-C downloads need no key. */
function toSseCDownloadKey(setting: EncryptionSetting | undefined): SseCDownloadKey | undefined {
  const sseC = toSseCEncryptionSetting(setting)
  if (sseC === undefined) return undefined
  return {
    algorithm: sseC.algorithm,
    customerKey: sseC.customerKey,
    customerKeyMd5: sseC.customerKeyMd5,
  }
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
