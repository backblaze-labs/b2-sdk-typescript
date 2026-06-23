import { readStreamChunkWithTimeout } from './b2-sha1-reader.ts'
import {
  assertDownloadPathSameDevice,
  createDownloadStagingDirectory,
  DOWNLOAD_STAGING_DIRECTORY_NAME,
} from './download-staging.ts'
import { assertSameScannedRegularFile } from './local-file-identity.ts'
import {
  assertPathInsideRoot,
  hasErrorCode,
  noFollowFlag,
  safeRelativePathSegments,
} from './path-safety.ts'
import { DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS } from './sha1-options.ts'
import type { LocalSyncPath } from './types.ts'

type DeviceStat = { readonly dev: number | bigint }
type DeviceStatFn = (path: string) => Promise<DeviceStat>

export { DOWNLOAD_STAGING_DIRECTORY_NAME }

/** @internal */
export const localFileIoTestHooks: {
  afterParentDirectoryValidated?: (path: string) => Promise<void> | void
  afterTempFileCreated?: (path: string, stagingDirectory: string) => Promise<void> | void
  beforeFinalRename?: (path: string) => Promise<void> | void
  beforeLocalDeleteOpenParent?: (path: string) => Promise<void> | void
  beforeLocalDeleteUnlink?: (path: string) => Promise<void> | void
  beforeStagingMarkerWrite?: (path: string) => Promise<void> | void
  disableProcFdAnchoring?: boolean
  statForDeviceCheck?: DeviceStatFn
} = {}

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
      idleTimeoutMillis: DEFAULT_SHA1_IDLE_TIMEOUT_MILLIS,
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
  const { chmod, lstat, mkdir, open, realpath, rename, rm, stat } = await import('node:fs/promises')
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
  const statForDeviceCheck = localFileIoTestHooks.statForDeviceCheck ?? stat
  await assertDownloadPathSameDevice(
    rootRealPath,
    parentRealPath,
    statForDeviceCheck,
    'unsafe local destination path: cannot publish download across filesystems',
  )

  let parentHandle: Awaited<ReturnType<typeof open>> | undefined
  let anchoredParentPath: string | undefined
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  /* v8 ignore start -- Linux-only fd-relative path support is covered by Linux CI */
  if (
    platform === 'linux' &&
    constants.O_DIRECTORY !== undefined &&
    localFileIoTestHooks.disableProcFdAnchoring !== true
  ) {
    try {
      parentHandle = await open(
        parentRealPath,
        constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag(constants),
      )
      anchoredParentPath = `/proc/self/fd/${parentHandle.fd}`
    } catch (err) {
      if (hasErrorCode(err, 'ELOOP') || hasErrorCode(err, 'ENOTDIR')) {
        throw new Error('unsafe local destination path: parent is not a directory')
      }
      throw err
    }
  }
  /* v8 ignore stop */
  const finalName = path.basename(destPath)
  const finalWritePath = path.join(anchoredParentPath ?? parentRealPath, finalName)
  const publishMode = await replacementFileMode(finalPath)
  let stagingDirectory: string
  try {
    stagingDirectory = await createDownloadStagingDirectory(
      rootRealPath,
      path,
      randomUUID,
      statForDeviceCheck,
      localFileIoTestHooks.beforeStagingMarkerWrite,
    )
  } catch (err) {
    /* v8 ignore next -- best-effort close during setup failure */
    await parentHandle?.close().catch(() => {})
    throw err
  }
  const tmpPath = path.join(stagingDirectory, `${randomUUID()}.partial`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(constants),
      PRIVATE_DOWNLOAD_FILE_MODE,
    )
    /* v8 ignore next -- best-effort chmod */
    await chmod(tmpPath, PRIVATE_DOWNLOAD_FILE_MODE).catch(() => {})
    await localFileIoTestHooks.afterTempFileCreated?.(tmpPath, stagingDirectory)
    /* v8 ignore start -- defensive cleanup before the main write try/finally exists */
  } catch (err) {
    await parentHandle?.close().catch(() => {})
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  /* v8 ignore stop */
  const tmpRealPath = await realpath(tmpPath)
  assertPathInsideRoot(stagingDirectory, tmpRealPath, path)
  const writeHandle = handle
  const reader = body.getReader()
  let completed = false
  try {
    let bytesWritten = 0
    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(
        reader,
        options.idleTimeoutMillis,
        `download read stalled for ${options.idleTimeoutMillis} ms`,
        options.signal,
      )
      if (done) break
      if (bytesWritten + value.byteLength > options.expectedBytes) {
        throw new Error(`download read exceeded ${options.expectedBytes} byte limit`)
      }
      await writeAll(writeHandle, value, bytesWritten)
      bytesWritten += value.byteLength
    }
    if (bytesWritten !== options.expectedBytes) {
      throw new Error(
        `download read ended after ${bytesWritten} bytes, expected ${options.expectedBytes}`,
      )
    }
    await writeHandle.close()
    handle = undefined
    if (publishMode !== PRIVATE_DOWNLOAD_FILE_MODE) {
      /* v8 ignore next -- best-effort mode preservation */
      await chmod(tmpPath, publishMode).catch(() => {})
    }

    const [parentRealPathBeforeRename, parentStatsBeforeRename] = await Promise.all([
      realpath(path.dirname(destPath)),
      stat(path.dirname(destPath)),
    ])
    const finalPathBeforeRename = path.join(parentRealPathBeforeRename, path.basename(destPath))
    assertPathInsideRoot(rootRealPath, finalPathBeforeRename, path)
    await localFileIoTestHooks.beforeFinalRename?.(parentRealPathBeforeRename)
    let publishPath = finalWritePath
    if (anchoredParentPath === undefined) {
      const [parentRealPathAfterHook, parentStatsAfterHook] = await Promise.all([
        realpath(path.dirname(destPath)),
        stat(path.dirname(destPath)),
      ])
      if (
        parentRealPathAfterHook !== parentRealPathBeforeRename ||
        !sameParentIdentity(parentStatsAfterHook, parentStatsBeforeRename)
      ) {
        throw new Error('unsafe local destination path: parent changed before final publish')
      }
      publishPath = path.join(parentRealPathAfterHook, path.basename(destPath))
      assertPathInsideRoot(rootRealPath, publishPath, path)
    }
    await rename(tmpPath, publishPath)
    completed = true
  } catch (err) {
    /* v8 ignore next -- best-effort cleanup */
    void reader.cancel(err).catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
    if (!completed) {
      /* v8 ignore next -- best-effort cleanup */
      await handle?.close().catch(() => {})
      /* v8 ignore next -- best-effort cleanup */
      await rm(tmpPath, { force: true }).catch(() => {})
    }
    /* v8 ignore next -- best-effort cleanup */
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    /* v8 ignore next -- best-effort cleanup */
    await parentHandle?.close().catch(() => {})
  }
}

const PRIVATE_DOWNLOAD_FILE_MODE = 0o600
async function replacementFileMode(filePath: string): Promise<number> {
  const { lstat } = await import('node:fs/promises')
  try {
    const stats = await lstat(filePath)
    return stats.isFile() ? stats.mode & 0o777 : PRIVATE_DOWNLOAD_FILE_MODE
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return PRIVATE_DOWNLOAD_FILE_MODE
    throw err
  }
}

/**
 * Deletes a scanned local file under a sync root without re-resolving attacker-controlled parents.
 *
 * @param root - Local sync root.
 * @param scannedPath - Previously scanned local file metadata.
 *
 * @internal
 */
export async function deleteLocalFileInsideRoot(
  root: string,
  scannedPath: LocalSyncPath,
): Promise<void> {
  if (root === '') {
    throw new Error('Local sync root required for filesystem mutation')
  }

  const { constants } = await import('node:fs')
  const { lstat, open, realpath, unlink } = await import('node:fs/promises')
  const path = await import('node:path')
  const segments = safeRelativePathSegments(scannedPath.relativePath)
  const safeRoot = path.resolve(root)
  const rootStats = await lstat(safeRoot)
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Refusing to access sync root through symlink: ${scannedPath.relativePath}`)
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Local sync root is not a directory: ${scannedPath.relativePath}`)
  }
  const rootRealPath = await realpath(safeRoot)
  const expectedPath = path.join(rootRealPath, ...segments)
  assertPathInsideRoot(rootRealPath, expectedPath, path)

  const scannerPath = path.resolve(scannedPath.absolutePath)
  if (scannerPath !== expectedPath) {
    throw new Error(`Refusing to delete outside sync root: ${scannedPath.relativePath}`)
  }

  const parentRealPath = await realpath(path.dirname(expectedPath))
  const finalPath = path.join(parentRealPath, path.basename(expectedPath))
  assertPathInsideRoot(rootRealPath, finalPath, path)

  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  if (platform !== 'linux' || constants.O_DIRECTORY === undefined) {
    throw new Error('unsafe local delete path: anchored deletion is not available')
  }

  let parentHandle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await localFileIoTestHooks.beforeLocalDeleteOpenParent?.(parentRealPath)
    parentHandle = await open(
      parentRealPath,
      constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag(constants),
    )
  } catch (err) {
    if (hasErrorCode(err, 'ELOOP') || hasErrorCode(err, 'ENOTDIR')) {
      throw new Error('unsafe local delete path: parent is not a directory')
    }
    throw err
  }

  try {
    const anchoredPath = path.join(`/proc/self/fd/${parentHandle.fd}`, path.basename(expectedPath))
    const stats = await lstat(anchoredPath)
    assertSameScannedRegularFile(stats, scannedPath, 'delete')
    await localFileIoTestHooks.beforeLocalDeleteUnlink?.(parentRealPath)
    await unlink(anchoredPath)
  } finally {
    /* v8 ignore next -- best-effort cleanup */
    await parentHandle.close().catch(() => {})
  }
}

function sameParentIdentity(
  current: { readonly dev: number | bigint; readonly ino: number | bigint },
  expected: { readonly dev: number | bigint; readonly ino: number | bigint },
): boolean {
  return current.dev === expected.dev && current.ino === expected.ino
}

async function writeAll(
  handle: {
    write(
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ readonly bytesWritten: number }>
  },
  data: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.byteLength - offset,
      position + offset,
    )
    /* v8 ignore next -- defensive: FileHandle.write should progress for non-empty chunks. */
    if (bytesWritten <= 0) throw new Error('download write made no progress')
    offset += bytesWritten
  }
}
