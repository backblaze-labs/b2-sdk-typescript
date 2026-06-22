import { readStreamChunkWithTimeout } from './b2-sha1-reader.ts'
import {
  assertDownloadPathSameDevice,
  createDownloadStagingDirectory,
  DOWNLOAD_STAGING_DIRECTORY_NAME,
  isDownloadStagingDirectorySegment,
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
  beforeDownloadPublish?: (path: string) => Promise<void> | void
  beforeFinalRename?: (path: string) => Promise<void> | void
  beforeLocalDeleteOpenParent?: (path: string) => Promise<void> | void
  beforeLocalDeleteUnlink?: (path: string) => Promise<void> | void
  beforeStagingMarkerWrite?: (path: string) => Promise<void> | void
  disableProcFdAnchoring?: boolean
  statForDeviceCheck?: DeviceStatFn
} = {}

interface ScannedLocalFileHandle {
  stat(): Promise<{
    isFile(): boolean
    readonly dev: number
    readonly ino: number
    readonly mtimeMs: number
    readonly size: number
  }>
  readFile(): Promise<Uint8Array>
  close(): Promise<void>
}

/**
 * Verifies that a previously scanned local file still points at the same regular file.
 *
 * @param path - Scanned local path and file identity.
 *
 * @internal
 */
export async function validateScannedLocalFile(path: LocalSyncPath): Promise<void> {
  const handle = await openValidatedScannedLocalFile(path)
  await handle.close()
}

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
  const handle = await openValidatedScannedLocalFile(path)
  try {
    const data = await handle.readFile()
    if (data.byteLength !== path.size) {
      throw new Error('local file changed before upload: size changed while reading')
    }
    return data
  } finally {
    await handle.close()
  }
}

async function openValidatedScannedLocalFile(path: LocalSyncPath): Promise<ScannedLocalFileHandle> {
  const { constants } = await import('node:fs')
  const { open } = await import('node:fs/promises')
  const flags =
    constants.O_RDONLY |
    noFollowFlag(constants) |
    ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0)
  const handle = await open(path.absolutePath, flags).catch((err: unknown) => {
    if (hasErrorCode(err, 'ELOOP')) {
      throw new Error('local file changed before upload: not a regular file')
    }
    throw new Error(
      `local file changed before upload: could not open scanned file: ${sanitizeErrorReason(err)}`,
    )
  })
  try {
    const stats = await handle.stat()
    assertSameScannedRegularFile(stats, path)
    return handle
  } catch (err) {
    await handle.close().catch(() => {})
    throw err
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
    readonly expectedDestination?: LocalSyncPath | null
    readonly idleTimeoutMillis: number
    readonly signal?: AbortSignal
  },
): Promise<void> {
  const { constants } = await import('node:fs')
  const { link, lstat, mkdir, open, realpath, rename, rm, stat } = await import('node:fs/promises')
  const path = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  assertValidExpectedBytes(options.expectedBytes)
  const segments = safeRelativePathSegments(relPath)
  if (isDownloadStagingDirectorySegment(segments[0])) {
    throw new Error(
      `unsafe local destination path: ${DOWNLOAD_STAGING_DIRECTORY_NAME} is reserved for SDK download staging`,
    )
  }
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
  try {
    const targetStats = await lstat(finalPath)
    if (targetStats.isSymbolicLink()) {
      throw new Error('unsafe local destination path: target is a symbolic link')
    }
    if (targetStats.isFile() && targetStats.nlink > 1) {
      throw new Error('unsafe local destination path: target has multiple hard links')
    }
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw err
  }
  await options.downloadTempFileSweeper?.(parentRealPath)

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
  let publishMode: number
  try {
    publishMode = await replacementFileMode(finalPath)
  } catch (err) {
    /* v8 ignore next -- best-effort close during setup failure */
    await parentHandle?.close().catch(() => {})
    throw err
  }
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
  const tmpPath = path.join(stagingDirectory, `.b2sdk-${randomUUID()}.partial`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(constants),
      PRIVATE_DOWNLOAD_FILE_MODE,
    )
    /* v8 ignore next -- best-effort chmod */
    await handle.chmod(PRIVATE_DOWNLOAD_FILE_MODE).catch(() => {})
    await localFileIoTestHooks.afterTempFileCreated?.(tmpPath, stagingDirectory)
    /* v8 ignore start -- defensive cleanup before the main write try/finally exists */
  } catch (err) {
    await parentHandle?.close().catch(() => {})
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  /* v8 ignore stop */
  try {
    const tmpRealPath = await realpath(tmpPath)
    assertPathInsideRoot(stagingDirectory, tmpRealPath, path)
  } catch (err) {
    /* v8 ignore next -- best-effort cleanup */
    await handle?.close().catch(() => {})
    /* v8 ignore next -- best-effort cleanup */
    await rm(tmpPath, { force: true }).catch(() => {})
    /* v8 ignore next -- best-effort cleanup */
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    /* v8 ignore next -- best-effort cleanup */
    await parentHandle?.close().catch(() => {})
    throw err
  }
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
    if (publishMode !== PRIVATE_DOWNLOAD_FILE_MODE) {
      /* v8 ignore next -- best-effort mode preservation */
      await writeHandle.chmod(publishMode).catch(() => {})
    }
    await writeHandle.close()
    handle = undefined

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
    await publishDownload(
      lstat,
      link,
      path,
      randomUUID,
      rename,
      rm,
      tmpPath,
      publishPath,
      options.expectedDestination,
    )
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

function assertValidExpectedBytes(expectedBytes: number): void {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error('download expectedBytes must be a non-negative safe integer')
  }
}

async function assertExpectedDownloadDestination(
  lstat: typeof import('node:fs/promises')['lstat'],
  finalPath: string,
  expectedDestination: LocalSyncPath | null | undefined,
): Promise<void> {
  if (expectedDestination === undefined) return

  try {
    const stats = await lstat(finalPath)
    if (expectedDestination === null) {
      throw new Error('local destination changed before download: file was created')
    }
    assertSameScannedRegularFile(
      stats,
      { ...expectedDestination, absolutePath: finalPath },
      'download',
    )
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) {
      if (expectedDestination === null) return
      throw new Error('local file changed before download: file missing')
    }
    throw err
  }
}

async function publishDownload(
  lstat: typeof import('node:fs/promises')['lstat'],
  link: typeof import('node:fs/promises')['link'],
  path: typeof import('node:path'),
  randomUUID: () => string,
  rename: typeof import('node:fs/promises')['rename'],
  rm: typeof import('node:fs/promises')['rm'],
  tmpPath: string,
  publishPath: string,
  expectedDestination: LocalSyncPath | null | undefined,
): Promise<void> {
  await assertExpectedDownloadDestination(lstat, publishPath, expectedDestination)
  await localFileIoTestHooks.beforeDownloadPublish?.(publishPath)

  if (expectedDestination === undefined) {
    await rename(tmpPath, publishPath)
    return
  }

  if (expectedDestination === null) {
    await linkDownloadNoOverwrite(
      link,
      tmpPath,
      publishPath,
      'local destination changed before download: file was created',
    )
    /* v8 ignore next -- staging cleanup is best-effort after a guarded publish succeeds. */
    await rm(tmpPath, { force: true }).catch(() => {})
    return
  }

  const backupPath = path.join(path.dirname(publishPath), `.b2sdk-${randomUUID()}.partial`)
  let backupExists = false
  let removeBackup = false

  try {
    try {
      await rename(publishPath, backupPath)
      backupExists = true
    } catch (err) {
      if (hasErrorCode(err, 'ENOENT')) {
        throw new Error('local file changed before download: file missing')
      }
      throw err
    }

    const backupStats = await lstat(backupPath)
    assertSameScannedRegularFile(
      backupStats,
      { ...expectedDestination, absolutePath: backupPath },
      'download',
    )
    await linkDownloadNoOverwrite(
      link,
      tmpPath,
      publishPath,
      'local destination changed before download: file was created',
    )
    removeBackup = true
    /* v8 ignore next -- staging cleanup is best-effort after a guarded publish succeeds. */
    await rm(tmpPath, { force: true }).catch(() => {})
  } catch (err) {
    if (backupExists && !removeBackup) {
      await restoreBackupWithoutOverwrite(link, rm, backupPath, publishPath).catch(() => {})
    }
    throw err
  } finally {
    if (removeBackup) {
      /* v8 ignore next -- old destination cleanup is best-effort after publish succeeds. */
      await rm(backupPath, { force: true }).catch(() => {})
    }
  }
}

async function linkDownloadNoOverwrite(
  link: typeof import('node:fs/promises')['link'],
  sourcePath: string,
  destPath: string,
  message: string,
): Promise<void> {
  try {
    await link(sourcePath, destPath)
  } catch (err) {
    if (hasErrorCode(err, 'EEXIST')) throw new Error(message)
    throw err
  }
}

async function restoreBackupWithoutOverwrite(
  link: typeof import('node:fs/promises')['link'],
  rm: typeof import('node:fs/promises')['rm'],
  backupPath: string,
  publishPath: string,
): Promise<void> {
  try {
    await link(backupPath, publishPath)
    await rm(backupPath, { force: true })
  } catch (err) {
    if (hasErrorCode(err, 'EEXIST')) return
    throw err
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
  const { lstat, open, realpath, stat, unlink } = await import('node:fs/promises')
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

  const [parentRealPath, parentStats] = await Promise.all([
    realpath(path.dirname(expectedPath)),
    stat(path.dirname(expectedPath)),
  ])
  const finalPath = path.join(parentRealPath, path.basename(expectedPath))
  assertPathInsideRoot(rootRealPath, finalPath, path)

  const platform = (globalThis as { process?: { platform?: string } }).process?.platform
  let parentHandle: Awaited<ReturnType<typeof open>> | undefined
  let anchoredParentPath: string | undefined
  /* v8 ignore start -- Linux-only fd-relative path support is covered by Linux CI */
  if (
    platform === 'linux' &&
    constants.O_DIRECTORY !== undefined &&
    localFileIoTestHooks.disableProcFdAnchoring !== true
  ) {
    try {
      await localFileIoTestHooks.beforeLocalDeleteOpenParent?.(parentRealPath)
      parentHandle = await open(
        parentRealPath,
        constants.O_RDONLY | constants.O_DIRECTORY | noFollowFlag(constants),
      )
      anchoredParentPath = `/proc/self/fd/${parentHandle.fd}`
    } catch (err) {
      if (hasErrorCode(err, 'ELOOP') || hasErrorCode(err, 'ENOTDIR')) {
        throw new Error('unsafe local delete path: parent is not a directory')
      }
      throw err
    }
  }
  /* v8 ignore stop */

  try {
    const unlinkPath =
      anchoredParentPath === undefined
        ? finalPath
        : path.join(anchoredParentPath, path.basename(expectedPath))
    const stats = await lstat(unlinkPath)
    assertSameScannedRegularFile(stats, { ...scannedPath, absolutePath: unlinkPath }, 'delete')
    await localFileIoTestHooks.beforeLocalDeleteUnlink?.(parentRealPath)
    if (
      anchoredParentPath === undefined &&
      localFileIoTestHooks.disableProcFdAnchoring === true &&
      parentRealPath !== rootRealPath
    ) {
      throw new Error('unsafe local delete path: stable parent handle unavailable for unlink')
    }

    if (anchoredParentPath === undefined) {
      const [parentRealPathBeforeUnlink, parentStatsBeforeUnlink] = await Promise.all([
        realpath(path.dirname(expectedPath)),
        stat(path.dirname(expectedPath)),
      ])
      if (
        parentRealPathBeforeUnlink !== parentRealPath ||
        !sameParentIdentity(parentStatsBeforeUnlink, parentStats)
      ) {
        throw new Error('unsafe local delete path: parent changed before unlink')
      }
    }
    const finalStats = await lstat(unlinkPath)
    assertSameScannedRegularFile(finalStats, { ...scannedPath, absolutePath: unlinkPath }, 'delete')
    await unlink(unlinkPath)
  } finally {
    /* v8 ignore next -- best-effort cleanup */
    await parentHandle?.close().catch(() => {})
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
