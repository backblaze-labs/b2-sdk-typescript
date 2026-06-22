import { readStreamChunkWithTimeout } from './b2-sha1-reader.ts'
import {
  assertPathInsideRoot,
  hasErrorCode,
  noFollowFlag,
  safeRelativePathSegments,
} from './path-safety.ts'
import type { LocalSyncPath } from './types.ts'

/** @internal */
export const localFileIoTestHooks: {
  afterParentDirectoryValidated?: (path: string) => Promise<void> | void
} = {}

/**
 * Reads a previously scanned local file while rejecting symlink swaps and metadata drift.
 *
 * @param path - Scanned local path and file identity.
 *
 * @returns The file bytes.
 *
 * @internal
 */
export async function readScannedLocalFile(path: LocalSyncPath): Promise<Uint8Array> {
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

/**
 * Writes bytes under a local sync root after path containment checks.
 *
 * @param root - Local sync root.
 * @param relPath - Destination path relative to the root.
 * @param data - Bytes to write.
 *
 * @internal
 */
export async function writeLocalFileInsideRoot(
  root: string,
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  await writeLocalStreamInsideRoot(
    root,
    relPath,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    }),
    {
      expectedBytes: data.byteLength,
      idleTimeoutMillis: 30_000,
    },
  )
}

/**
 * Streams a B2 download under a local sync root with path, timeout, and size checks.
 *
 * @param root - Local sync root.
 * @param relPath - Destination path relative to the root.
 * @param body - Download body stream.
 * @param options - Expected byte count, idle timeout, and optional abort signal.
 *
 * @internal
 */
export async function writeLocalStreamInsideRoot(
  root: string,
  relPath: string,
  body: ReadableStream<Uint8Array>,
  options: {
    readonly expectedBytes: number
    readonly idleTimeoutMillis: number
    readonly signal?: AbortSignal
  },
): Promise<void> {
  const { constants } = await import('node:fs')
  const { lstat, mkdir, open, realpath, rename, rm } = await import('node:fs/promises')
  const path = await import('node:path')
  const { randomUUID } = await import('node:crypto')
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
    await localFileIoTestHooks.afterParentDirectoryValidated?.(current)
  }

  const destPath = path.join(rootRealPath, ...segments)
  assertPathInsideRoot(rootRealPath, destPath, path)

  const parentRealPath = await realpath(path.dirname(destPath))
  const finalPath = path.join(parentRealPath, path.basename(destPath))
  assertPathInsideRoot(rootRealPath, finalPath, path)

  const tmpPath = path.join(parentRealPath, `.${path.basename(destPath)}.${randomUUID()}.tmp`)
  const handle = await open(
    tmpPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(constants),
    0o666,
  )
  const tmpRealPath = await realpath(tmpPath)
  assertPathInsideRoot(rootRealPath, tmpRealPath, path)
  const reader = body.getReader()
  let completed = false
  try {
    let bytesRead = 0
    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(
        reader,
        options.idleTimeoutMillis,
        `download read stalled for ${options.idleTimeoutMillis} ms`,
        options.signal,
      )
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > options.expectedBytes) {
        throw new Error(`download read exceeded ${options.expectedBytes} byte limit`)
      }
      await handle.writeFile(value)
    }
    if (bytesRead !== options.expectedBytes) {
      throw new Error(
        `download read ended after ${bytesRead} bytes, expected ${options.expectedBytes}`,
      )
    }
    await handle.close()

    const parentRealPathBeforeRename = await realpath(path.dirname(destPath))
    const finalPathBeforeRename = path.join(parentRealPathBeforeRename, path.basename(destPath))
    assertPathInsideRoot(rootRealPath, finalPathBeforeRename, path)
    await rename(tmpPath, finalPathBeforeRename)
    completed = true
  } catch (err) {
    void reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
    if (!completed) {
      await handle.close().catch(() => {})
      await rm(tmpPath, { force: true }).catch(() => {})
    }
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
