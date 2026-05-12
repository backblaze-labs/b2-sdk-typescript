import { mkdir } from 'node:fs/promises'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Bucket } from '../bucket.js'
import { BufferSource } from '../streams/source.js'
import type { FileId } from '../types/ids.js'
import { Semaphore } from '../upload/concurrency.js'
import type { SyncAction } from './actions/index.js'
import {
  CopyAction,
  DeleteLocalAction,
  DeleteRemoteAction,
  DownloadAction,
  HideAction,
  UploadAction,
} from './actions/index.js'
import { zipFolders } from './pairing.js'
import type { ActionFactory } from './policies/index.js'
import { generateActions } from './policies/index.js'
import type {
  B2SyncPath,
  LocalSyncPath,
  SyncDirection,
  SyncEvent,
  SyncFolder,
  SyncOptions,
} from './types.js'

export interface SynchronizerConfig {
  readonly source: SyncFolder
  readonly dest: SyncFolder
  readonly options: SyncOptions
}

export interface SynchronizerUpConfig extends SynchronizerConfig {
  readonly source: SyncFolder & { readonly type: 'local'; readonly root: string }
  readonly dest: SyncFolder & { readonly type: 'b2' }
  readonly bucket: Bucket
  readonly prefix: string
}

export interface SynchronizerDownConfig extends SynchronizerConfig {
  readonly source: SyncFolder & { readonly type: 'b2' }
  readonly dest: SyncFolder & { readonly type: 'local'; readonly root: string }
  readonly bucket: Bucket
}

function resolveDirection(source: SyncFolder, dest: SyncFolder): SyncDirection {
  if (source.type === 'local' && dest.type === 'b2') return 'local-to-b2'
  if (source.type === 'b2' && dest.type === 'local') return 'b2-to-local'
  if (source.type === 'b2' && dest.type === 'b2') return 'b2-to-b2'
  throw new Error(`Unsupported sync direction: ${source.type} to ${dest.type}`)
}

export async function* synchronize(config: SynchronizerConfig): AsyncGenerator<SyncEvent> {
  const { source, dest, options } = config
  const direction = resolveDirection(source, dest)
  const dryRun = options.dryRun ?? false
  const concurrency = options.concurrency ?? 4
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
      errors.push(err instanceof Error ? err : new Error(String(err)))
      results.push({
        type: 'error',
        path: action.relativePath,
        size: 0,
        message: err instanceof Error ? err.message : String(err),
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

function createActionFactory(config: SynchronizerConfig): ActionFactory {
  const upConfig = config as Partial<SynchronizerUpConfig>
  const downConfig = config as Partial<SynchronizerDownConfig>

  return {
    upload(source: LocalSyncPath): SyncAction {
      const bucket = upConfig.bucket
      const prefix = upConfig.prefix ?? ''
      if (!bucket) throw new Error('Bucket required for upload actions')

      return new UploadAction(
        source.relativePath,
        source.absolutePath,
        source.size,
        async (absPath, relPath) => {
          const data = await readFile(absPath)
          await bucket.upload({
            fileName: `${prefix}${relPath}`,
            source: new BufferSource(new Uint8Array(data)),
          })
        },
      )
    },

    download(source: B2SyncPath): SyncAction {
      const bucket = downConfig.bucket
      const root =
        downConfig.dest?.type === 'local' ? (downConfig.dest as { root: string }).root : ''
      if (!bucket) throw new Error('Bucket required for download actions')

      return new DownloadAction(source.relativePath, source.size, async (relPath) => {
        const result = await bucket.download(source.selectedVersion.fileName)
        const reader = result.body.getReader()
        const chunks: Uint8Array[] = []
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        let total = 0
        for (const c of chunks) total += c.byteLength
        const combined = new Uint8Array(total)
        let offset = 0
        for (const c of chunks) {
          combined.set(c, offset)
          offset += c.byteLength
        }

        const destPath = join(root, relPath)
        await mkdir(dirname(destPath), { recursive: true })
        await writeFile(destPath, combined)
      })
    },

    copy(source: B2SyncPath, destPath: string): SyncAction {
      const bucket = upConfig.bucket
      if (!bucket) throw new Error('Bucket required for copy actions')

      return new CopyAction(source.relativePath, source.size, async () => {
        await bucket.copyFile({
          sourceFileId: source.selectedVersion.fileId,
          fileName: destPath,
        })
      })
    },

    hide(path: string): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      if (!bucket) throw new Error('Bucket required for hide actions')

      return new HideAction(path, async (relPath) => {
        const prefix = upConfig.prefix ?? ''
        await bucket.hideFile(`${prefix}${relPath}`)
      })
    },

    deleteRemote(path: B2SyncPath): SyncAction {
      const bucket = upConfig.bucket ?? downConfig.bucket
      if (!bucket) throw new Error('Bucket required for delete actions')

      return new DeleteRemoteAction(
        path.relativePath,
        path.selectedVersion.fileId as string,
        async (fileId, fileName) => {
          await bucket.deleteFileVersion(fileName, fileId as unknown as FileId)
        },
      )
    },

    deleteLocal(path: LocalSyncPath): SyncAction {
      return new DeleteLocalAction(path.relativePath, path.absolutePath, async (absPath) => {
        await unlink(absPath)
      })
    },
  }
}
