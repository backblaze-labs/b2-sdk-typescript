import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_STAGING_ACTIVITY_ENTRY_LIMIT,
  DOWNLOAD_STAGING_DIRECTORY_NAME,
  DOWNLOAD_STAGING_MARKER_NAME,
  isManagedDownloadStagingRoot,
} from './download-staging.ts'
import { assertSameScannedRegularFile, localFileIdentityFromStats } from './local-file-identity.ts'
import {
  deleteLocalFileInsideRoot,
  localFileIoTestHooks,
  writeLocalFileInsideRoot,
  writeLocalStreamInsideRoot,
} from './local-file-io.ts'
import type { LocalSyncPath } from './types.ts'

const textEncoder = new TextEncoder()
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function makeScannedPath(
  root: string,
  relativePath: string,
  contents: string,
): Promise<LocalSyncPath> {
  const absolutePath = join(root, ...relativePath.split('/'))
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents)
  const stats = await stat(absolutePath)
  return {
    relativePath,
    absolutePath,
    modTimeMillis: Math.floor(stats.mtimeMs),
    size: stats.size,
    fileIdentity: localFileIdentityFromStats(stats),
  }
}

async function oldScannerVisibleFiles(root: string, dir = root): Promise<string[]> {
  const visible: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      visible.push(...(await oldScannerVisibleFiles(root, fullPath)))
      continue
    }
    if (entry.isFile() && !/^\.b2sdk-.*\.partial$/.test(entry.name)) {
      visible.push(relative(root, fullPath).split(sep).join('/'))
    }
  }
  return visible.sort()
}

describe('writeLocalFileInsideRoot', () => {
  it('writes bytes under the resolved root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-write-'))
    try {
      await writeLocalFileInsideRoot(root, 'nested/file.txt', textEncoder.encode('abc'))

      await expect(readFile(join(root, 'nested', 'file.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writeLocalStreamInsideRoot', () => {
  it('rejects invalid expected byte counts before staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-byte-count-'))
    try {
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(new Uint8Array()), {
          expectedBytes: -1,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download expectedBytes must be a non-negative safe integer')

      await expect(readdir(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)(
    'creates private managed staging files under the destination root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-private-'))
      let observedTempPath = ''
      let observedStagingDirectory = ''
      try {
        localFileIoTestHooks.afterTempFileCreated = async (tempPath, stagingDirectory) => {
          observedTempPath = tempPath
          observedStagingDirectory = stagingDirectory
          const managedDirectory = join(await realpath(root), DOWNLOAD_STAGING_DIRECTORY_NAME)
          expect(tempPath.startsWith(managedDirectory)).toBe(true)
          expect(stagingDirectory.startsWith(managedDirectory)).toBe(true)
          expect((await stat(tempPath)).mode & 0o777).toBe(0o600)
          expect((await stat(stagingDirectory)).mode & 0o777).toBe(0o700)
          expect(await readdir(root)).toEqual([DOWNLOAD_STAGING_DIRECTORY_NAME])
        }

        await writeLocalStreamInsideRoot(
          root,
          'file.txt',
          streamFromBytes(textEncoder.encode('abc')),
          {
            expectedBytes: 3,
            idleTimeoutMillis: 1000,
          },
        )

        expect(observedTempPath).not.toBe('')
        expect(observedStagingDirectory).not.toBe('')
        expect((await stat(join(root, 'file.txt'))).mode & 0o777).toBe(0o600)
        await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
        await expect(readdir(join(root, DOWNLOAD_STAGING_DIRECTORY_NAME))).resolves.toEqual([
          DOWNLOAD_STAGING_MARKER_NAME,
        ])
      } finally {
        delete localFileIoTestHooks.afterTempFileCreated
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('keeps in-progress staging files hidden from the previous local scanner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-old-scanner-'))
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let stagingReady!: () => void
    const staged = new Promise<void>((resolve) => {
      stagingReady = resolve
    })
    try {
      localFileIoTestHooks.afterTempFileCreated = () => {
        stagingReady()
      }
      const writePromise = writeLocalStreamInsideRoot(
        root,
        'file.txt',
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        }),
        {
          expectedBytes: 0,
          idleTimeoutMillis: 1000,
        },
      )

      await staged
      expect(await oldScannerVisibleFiles(root)).toEqual([])
      controller.close()
      await writePromise
    } finally {
      delete localFileIoTestHooks.afterTempFileCreated
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('preserves mode when replacing existing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-mode-'))
    try {
      const secretPath = join(root, 'secret.txt')
      const scriptPath = join(root, 'script.sh')
      await writeFile(secretPath, 'old')
      await writeFile(scriptPath, '#!/bin/sh\n')
      await chmod(secretPath, 0o600)
      await chmod(scriptPath, 0o755)

      await writeLocalStreamInsideRoot(
        root,
        'secret.txt',
        streamFromBytes(textEncoder.encode('new')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )
      await writeLocalStreamInsideRoot(
        root,
        'script.sh',
        streamFromBytes(textEncoder.encode('echo ok\n')),
        {
          expectedBytes: 8,
          idleTimeoutMillis: 1000,
        },
      )

      expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
      expect((await stat(scriptPath)).mode & 0o777).toBe(0o755)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects download bodies that exceed the expected byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-overlong-'))
    try {
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abcd')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download read exceeded 3 byte limit')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects download bodies that end before the expected byte count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-truncated-'))
    try {
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 4,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download read ended after 3 bytes, expected 4')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to write into the managed staging namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-reserved-'))
    try {
      for (const stagingDirectoryName of [
        DOWNLOAD_STAGING_DIRECTORY_NAME,
        DOWNLOAD_STAGING_DIRECTORY_NAME.toUpperCase(),
      ]) {
        await expect(
          writeLocalStreamInsideRoot(
            root,
            `${stagingDirectoryName}/payload.bin`,
            streamFromBytes(textEncoder.encode('abc')),
            {
              expectedBytes: 3,
              idleTimeoutMillis: 1000,
            },
          ),
        ).rejects.toThrow(`${DOWNLOAD_STAGING_DIRECTORY_NAME} is reserved`)
      }
      await expect(readdir(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite a file created after destination validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-new-race-'))
    try {
      localFileIoTestHooks.beforeDownloadPublish = async (publishPath) => {
        await writeFile(publishPath, 'concurrent')
      }

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('new')), {
          expectedBytes: 3,
          expectedDestination: null,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('local destination changed before download: file was created')

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('concurrent')
    } finally {
      delete localFileIoTestHooks.beforeDownloadPublish
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite a replacement file after destination validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-replace-race-'))
    try {
      const scanned = await makeScannedPath(root, 'file.txt', 'old')
      localFileIoTestHooks.beforeDownloadPublish = async (publishPath) => {
        await rm(publishPath, { force: true })
        await writeFile(publishPath, 'concurrent')
      }

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('new')), {
          expectedBytes: 3,
          expectedDestination: scanned,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('local file changed before download')

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('concurrent')
    } finally {
      delete localFileIoTestHooks.beforeDownloadPublish
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when a scanned destination is missing before publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-missing-dest-'))
    try {
      const scanned = await makeScannedPath(root, 'file.txt', 'old')
      await rm(join(root, 'file.txt'))

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('new')), {
          expectedBytes: 3,
          expectedDestination: scanned,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('local file changed before download: file missing')

      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when a scanned destination disappears after validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-late-missing-'))
    try {
      const scanned = await makeScannedPath(root, 'file.txt', 'old')
      localFileIoTestHooks.beforeDownloadPublish = async (publishPath) => {
        await rm(publishPath, { force: true })
      }

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('new')), {
          expectedBytes: 3,
          expectedDestination: scanned,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('local file changed before download: file missing')

      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      delete localFileIoTestHooks.beforeDownloadPublish
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects download streams that emit too many empty chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-empty-chunks-'))
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < 1025; index++) controller.enqueue(new Uint8Array(0))
        },
      })

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', body, {
          expectedBytes: 1,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('download read stalled')

      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
      await expect(readdir(join(root, DOWNLOAD_STAGING_DIRECTORY_NAME))).resolves.toEqual([
        DOWNLOAD_STAGING_MARKER_NAME,
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('propagates replacement mode lookup errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-stat-error-'))
    try {
      const tooLongName = 'a'.repeat(300)
      await expect(
        writeLocalStreamInsideRoot(root, tooLongName, streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects destination parents on a different device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-dev-parent-'))
    const subdir = join(root, 'sub')
    try {
      await mkdir(subdir)
      const realSubdir = await realpath(subdir)
      localFileIoTestHooks.statForDeviceCheck = async (candidate) => ({
        dev: candidate === realSubdir ? 2 : 1,
      })
      await expect(
        writeLocalStreamInsideRoot(
          root,
          'sub/file.txt',
          streamFromBytes(textEncoder.encode('abc')),
          {
            expectedBytes: 3,
            idleTimeoutMillis: 1000,
          },
        ),
      ).rejects.toThrow('cannot publish download across filesystems')
    } finally {
      delete localFileIoTestHooks.statForDeviceCheck
      await rm(root, { recursive: true, force: true })
    }
  })

  it('allows a destination root whose parent is on a different device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-dev-root-'))
    try {
      const rootParent = await realpath(join(root, '..'))
      localFileIoTestHooks.statForDeviceCheck = async (candidate) => ({
        dev: candidate === rootParent ? 2 : 1,
      })
      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )
      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      delete localFileIoTestHooks.statForDeviceCheck
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects managed staging directories on a different device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-dev-staging-'))
    try {
      const managedDirectory = join(await realpath(root), DOWNLOAD_STAGING_DIRECTORY_NAME)
      localFileIoTestHooks.statForDeviceCheck = async (candidate) => ({
        dev: candidate.startsWith(managedDirectory) ? 2 : 1,
      })
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('cannot stage download across filesystems')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      delete localFileIoTestHooks.statForDeviceCheck
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects created staging entries on a different device', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-dev-staging-entry-'))
    try {
      const managedDirectory = join(await realpath(root), DOWNLOAD_STAGING_DIRECTORY_NAME)
      localFileIoTestHooks.statForDeviceCheck = async (candidate) => ({
        dev: candidate.startsWith(`${managedDirectory}${sep}`) ? 2 : 1,
      })
      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('cannot stage download across filesystems')
      await expect(readdir(managedDirectory)).resolves.toEqual([DOWNLOAD_STAGING_MARKER_NAME])
    } finally {
      delete localFileIoTestHooks.statForDeviceCheck
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('rejects a managed staging root symlink before chmod', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-symlink-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-symlink-out-'))
    try {
      await chmod(outside, 0o755)
      const originalMode = (await stat(outside)).mode & 0o777
      await symlink(outside, join(root, DOWNLOAD_STAGING_DIRECTORY_NAME), 'dir')

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow(`${DOWNLOAD_STAGING_DIRECTORY_NAME} is not a directory`)

      expect((await stat(outside)).mode & 0o777).toBe(originalMode)
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('does not chmod a non-SDK staging name before rejecting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-user-root-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      await mkdir(managedDirectory)
      await writeFile(join(managedDirectory, 'user.txt'), 'user')
      await chmod(managedDirectory, 0o755)
      const originalMode = (await stat(managedDirectory)).mode & 0o777

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow(`${DOWNLOAD_STAGING_DIRECTORY_NAME} is reserved`)

      expect((await stat(managedDirectory)).mode & 0o777).toBe(originalMode)
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reaps stale SDK-owned staging directories before creating a new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-stale-stage-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const staleDirectory = join(managedDirectory, '2000-01-01-old.download')
      const unmarkedDirectory = join(managedDirectory, '2000-01-01-unmarked.download')
      const staleMarker = join(staleDirectory, DOWNLOAD_STAGING_MARKER_NAME)
      const stalePayload = join(staleDirectory, 'partial.bin')
      await mkdir(staleDirectory, { recursive: true, mode: 0o700 })
      await mkdir(unmarkedDirectory, { recursive: true, mode: 0o700 })
      await writeFile(staleMarker, '')
      await writeFile(stalePayload, 'old')
      await writeFile(join(unmarkedDirectory, 'partial.bin'), 'keep')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await utimes(staleMarker, old, old)
      await utimes(stalePayload, old, old)
      await utimes(staleDirectory, old, old)
      await utimes(unmarkedDirectory, old, old)

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
      await expect(readFile(join(staleDirectory, 'partial.bin'))).rejects.toThrow()
      await expect(readFile(join(unmarkedDirectory, 'partial.bin'), 'utf8')).resolves.toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not reap an old staging entry with a recently active partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-active-stage-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const activeDirectory = join(managedDirectory, '2000-01-01-active.download')
      const activeMarker = join(activeDirectory, DOWNLOAD_STAGING_MARKER_NAME)
      const activePartial = join(activeDirectory, 'partial.bin')
      await mkdir(activeDirectory, { recursive: true, mode: 0o700 })
      await writeFile(activeMarker, '')
      await writeFile(activePartial, 'still-writing')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await utimes(activeMarker, old, old)
      await utimes(activeDirectory, old, old)

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
      await expect(readFile(activePartial, 'utf8')).resolves.toBe('still-writing')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reaps stale SDK-owned staging directories on later downloads to the same root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-repeat-stage-'))
    try {
      await writeLocalStreamInsideRoot(
        root,
        'first.txt',
        streamFromBytes(textEncoder.encode('one')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const staleDirectory = join(managedDirectory, '2000-01-01-second.download')
      const staleMarker = join(staleDirectory, DOWNLOAD_STAGING_MARKER_NAME)
      const stalePayload = join(staleDirectory, 'partial.bin')
      await mkdir(staleDirectory, { recursive: true, mode: 0o700 })
      await writeFile(staleMarker, '')
      await writeFile(stalePayload, 'old')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await utimes(staleMarker, old, old)
      await utimes(stalePayload, old, old)
      await utimes(staleDirectory, old, old)

      await writeLocalStreamInsideRoot(
        root,
        'second.txt',
        streamFromBytes(textEncoder.encode('two')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'second.txt'), 'utf8')).resolves.toBe('two')
      await expect(readFile(join(staleDirectory, 'partial.bin'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts an existing managed staging marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-existing-marker-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      await mkdir(managedDirectory)
      await writeFile(join(managedDirectory, DOWNLOAD_STAGING_MARKER_NAME), '')

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
      await expect(readdir(managedDirectory)).resolves.toEqual([DOWNLOAD_STAGING_MARKER_NAME])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a missing staging candidate as unmanaged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-missing-marker-'))
    try {
      await expect(isManagedDownloadStagingRoot(join(root, 'missing'))).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('publishes nested destinations when fd anchoring is disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-no-anchor-'))
    try {
      await mkdir(join(root, 'safe'))
      localFileIoTestHooks.disableProcFdAnchoring = true

      await writeLocalStreamInsideRoot(
        root,
        'safe/payload.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'safe', 'payload.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      delete localFileIoTestHooks.disableProcFdAnchoring
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!isLinux)('does not follow a parent symlink swap during final rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-out-'))
    try {
      await mkdir(join(root, 'safe'))
      localFileIoTestHooks.beforeFinalRename = async () => {
        await rename(join(root, 'safe'), join(root, 'safe-real'))
        await symlink(outside, join(root, 'safe'), 'dir')
      }

      await writeLocalStreamInsideRoot(
        root,
        'safe/payload.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(outside, 'payload.txt'))).rejects.toThrow()
      await expect(readFile(join(root, 'safe-real', 'payload.txt'), 'utf8')).resolves.toBe('abc')
    } finally {
      delete localFileIoTestHooks.beforeFinalRename
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)(
    'rejects a parent symlink swap before final rename without fd anchoring',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-race-root-'))
      const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-rename-race-out-'))
      try {
        await mkdir(join(root, 'safe'))
        await writeFile(join(outside, 'payload.txt'), 'outside')
        localFileIoTestHooks.disableProcFdAnchoring = true
        localFileIoTestHooks.beforeFinalRename = async () => {
          await rename(join(root, 'safe'), join(root, 'safe-real'))
          await symlink(outside, join(root, 'safe'), 'dir')
        }

        await expect(
          writeLocalStreamInsideRoot(
            root,
            'safe/payload.txt',
            streamFromBytes(textEncoder.encode('abc')),
            {
              expectedBytes: 3,
              idleTimeoutMillis: 1000,
            },
          ),
        ).rejects.toThrow('parent changed before final publish')

        await expect(readFile(join(outside, 'payload.txt'), 'utf8')).resolves.toBe('outside')
        await expect(readFile(join(root, 'safe-real', 'payload.txt'))).rejects.toThrow()
      } finally {
        delete localFileIoTestHooks.beforeFinalRename
        delete localFileIoTestHooks.disableProcFdAnchoring
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    },
  )

  it('handles concurrent first downloads into a fresh staging root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-race-'))
    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          writeLocalStreamInsideRoot(
            root,
            `file-${index}.txt`,
            streamFromBytes(textEncoder.encode(`content-${index}`)),
            {
              expectedBytes: `content-${index}`.length,
              idleTimeoutMillis: 1000,
            },
          ),
        ),
      )

      await expect(readdir(join(root, DOWNLOAD_STAGING_DIRECTORY_NAME))).resolves.toEqual([
        DOWNLOAD_STAGING_MARKER_NAME,
      ])
      await expect(readFile(join(root, 'file-11.txt'), 'utf8')).resolves.toBe('content-11')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('rejects a staging marker symlink created before marker write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-marker-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-marker-out-'))
    try {
      const outsideMarker = join(outside, 'marker-target.txt')
      const managedDirectory = join(await realpath(root), DOWNLOAD_STAGING_DIRECTORY_NAME)
      await writeFile(outsideMarker, 'outside')
      let markerSwapped = false
      localFileIoTestHooks.beforeStagingMarkerWrite = async (directory) => {
        if (directory !== managedDirectory || markerSwapped) return
        markerSwapped = true
        await symlink(outsideMarker, join(directory, DOWNLOAD_STAGING_MARKER_NAME))
      }

      await expect(
        writeLocalStreamInsideRoot(root, 'file.txt', streamFromBytes(textEncoder.encode('abc')), {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        }),
      ).rejects.toThrow('staging marker is not a regular file')

      expect(markerSwapped).toBe(true)
      await expect(readFile(outsideMarker, 'utf8')).resolves.toBe('outside')
      await expect(readFile(join(root, 'file.txt'))).rejects.toThrow()
    } finally {
      delete localFileIoTestHooks.beforeStagingMarkerWrite
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('bounds cleanup over a large attacker-controlled staging tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-many-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      await mkdir(managedDirectory, { recursive: true })
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      for (let index = 0; index < 80; index++) {
        const directory = join(managedDirectory, `attacker-${index}.download`)
        await mkdir(directory)
        await writeFile(join(directory, 'payload.bin'), 'keep')
        await utimes(directory, old, old)
      }
      for (let index = 0; index < 12; index++) {
        const directory = join(managedDirectory, `sdk-${index}.download`)
        const marker = join(directory, DOWNLOAD_STAGING_MARKER_NAME)
        const payload = join(directory, 'payload.bin')
        await mkdir(directory)
        await writeFile(marker, '')
        await writeFile(payload, 'stale')
        await utimes(marker, old, old)
        await utimes(payload, old, old)
        await utimes(directory, old, old)
      }

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
      await expect(
        readFile(join(managedDirectory, 'attacker-79.download', 'payload.bin'), 'utf8'),
      ).resolves.toBe('keep')
      await expect(
        readFile(join(managedDirectory, 'sdk-0.download', 'payload.bin')),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats oversized managed staging entries as active during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-oversized-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const directory = join(managedDirectory, 'oversized.download')
      const marker = join(directory, DOWNLOAD_STAGING_MARKER_NAME)
      await mkdir(directory, { recursive: true })
      await writeFile(marker, '')

      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      for (let index = 0; index < DOWNLOAD_STAGING_ACTIVITY_ENTRY_LIMIT; index++) {
        const payload = join(directory, `payload-${index}.bin`)
        await writeFile(payload, 'stale')
        await utimes(payload, old, old)
      }
      await utimes(marker, old, old)
      await utimes(directory, old, old)

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      await expect(readFile(join(root, 'file.txt'), 'utf8')).resolves.toBe('abc')
      await expect(
        readFile(
          join(directory, `payload-${DOWNLOAD_STAGING_ACTIVITY_ENTRY_LIMIT - 1}.bin`),
          'utf8',
        ),
      ).resolves.toBe('stale')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isWindows)('sanitizes staging cleanup warning entry names and paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-staging-warning-'))
    const originalEmitWarning = process.emitWarning
    const warnings: string[] = []
    const maliciousName = `2000-\nFORGED.download`
    try {
      process.emitWarning = ((warning: string | Error) => {
        warnings.push(warning instanceof Error ? warning.message : warning)
      }) as typeof process.emitWarning

      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const directory = join(managedDirectory, maliciousName)
      const marker = join(directory, DOWNLOAD_STAGING_MARKER_NAME)
      const payload = join(directory, 'payload.bin')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(marker, '')
      await writeFile(payload, 'stale')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      await utimes(marker, old, old)
      await utimes(payload, old, old)
      await utimes(directory, old, old)
      await chmod(directory, 0o500)

      await writeLocalStreamInsideRoot(
        root,
        'file.txt',
        streamFromBytes(textEncoder.encode('abc')),
        {
          expectedBytes: 3,
          idleTimeoutMillis: 1000,
        },
      )

      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings.some((warning) => warning.includes(root))).toBe(false)
      expect(warnings.some((warning) => warning.includes('/tmp'))).toBe(false)
      expect(warnings.some((warning) => warning.includes('\n'))).toBe(false)
      expect(warnings.join(' ')).toContain('2000-?FORGED.download')
    } finally {
      process.emitWarning = originalEmitWarning
      await chmod(join(root, DOWNLOAD_STAGING_DIRECTORY_NAME, maliciousName), 0o700).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deleteLocalFileInsideRoot', () => {
  it('rejects a non-directory sync root', async () => {
    const rootParent = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-root-file-'))
    try {
      const root = join(rootParent, 'root-file')
      await writeFile(root, 'not-a-directory')

      await expect(
        deleteLocalFileInsideRoot(root, {
          relativePath: 'file.txt',
          absolutePath: join(root, 'file.txt'),
          modTimeMillis: 0,
          size: 0,
        }),
      ).rejects.toThrow('Local sync root is not a directory: file.txt')
    } finally {
      await rm(rootParent, { recursive: true, force: true })
    }
  })

  it('uses a parent recheck when anchored deletion is unavailable', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-unavailable-')),
    )
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')
      Object.defineProperty(process, 'platform', { value: 'darwin' })

      await deleteLocalFileInsideRoot(root, scannedPath)
      await expect(readFile(scannedPath.absolutePath)).rejects.toThrow()
    } finally {
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed for nested deletes when fd anchoring is deliberately disabled', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-disabled-anchor-')),
    )
    try {
      const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')
      localFileIoTestHooks.disableProcFdAnchoring = true

      await expect(deleteLocalFileInsideRoot(root, scannedPath)).rejects.toThrow(
        'unsafe local delete path: stable parent handle unavailable for unlink',
      )
      await expect(readFile(scannedPath.absolutePath, 'utf8')).resolves.toBe('delete-me')
    } finally {
      delete localFileIoTestHooks.disableProcFdAnchoring
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!isLinux)('does not follow a parent symlink swap during unlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-out-'))
    try {
      await mkdir(join(root, 'safe'))
      const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')
      await writeFile(join(outside, 'victim.txt'), 'keep')

      localFileIoTestHooks.beforeLocalDeleteUnlink = async () => {
        await rename(join(root, 'safe'), join(root, 'safe-real'))
        await symlink(outside, join(root, 'safe'), 'dir')
      }

      await deleteLocalFileInsideRoot(root, scannedPath)

      await expect(readFile(join(outside, 'victim.txt'), 'utf8')).resolves.toBe('keep')
      await expect(readFile(join(root, 'safe-real', 'victim.txt'))).rejects.toThrow()
    } finally {
      delete localFileIoTestHooks.beforeLocalDeleteUnlink
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects when the scanned leaf is replaced before unlink', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-leaf-')))
    try {
      const scannedPath = await makeScannedPath(root, 'victim.txt', 'original')

      localFileIoTestHooks.beforeLocalDeleteUnlink = async () => {
        await rename(join(root, 'victim.txt'), join(root, 'victim.old'))
        await writeFile(join(root, 'victim.txt'), 'replace!')
      }

      await expect(deleteLocalFileInsideRoot(root, scannedPath)).rejects.toThrow(
        'local file changed before delete',
      )
      await expect(readFile(join(root, 'victim.txt'), 'utf8')).resolves.toBe('replace!')
    } finally {
      delete localFileIoTestHooks.beforeLocalDeleteUnlink
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects parent replacement before unlink when fd anchoring is unavailable', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-parent-swap-')),
    )
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      localFileIoTestHooks.beforeLocalDeleteUnlink = async () => {
        await rename(join(root, 'safe'), join(root, 'safe-old'))
        await mkdir(join(root, 'safe'))
        await writeFile(join(root, 'safe', 'victim.txt'), 'replacement')
      }

      await expect(deleteLocalFileInsideRoot(root, scannedPath)).rejects.toThrow(
        'unsafe local delete path: parent changed before unlink',
      )
      await expect(readFile(join(root, 'safe', 'victim.txt'), 'utf8')).resolves.toBe('replacement')
      await expect(readFile(join(root, 'safe-old', 'victim.txt'), 'utf8')).resolves.toBe(
        'delete-me',
      )
    } finally {
      delete localFileIoTestHooks.beforeLocalDeleteUnlink
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!isLinux)(
    'fails closed if the parent stops being a directory before open',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-parent-file-'))
      try {
        await mkdir(join(root, 'safe'))
        const scannedPath = await makeScannedPath(root, 'safe/victim.txt', 'delete-me')

        localFileIoTestHooks.beforeLocalDeleteOpenParent = async (parentRealPath) => {
          await rm(parentRealPath, { recursive: true, force: true })
          await writeFile(parentRealPath, 'not-a-directory')
        }

        await expect(deleteLocalFileInsideRoot(root, scannedPath)).rejects.toThrow(
          'unsafe local delete path: parent is not a directory',
        )
      } finally {
        delete localFileIoTestHooks.beforeLocalDeleteOpenParent
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

describe('assertSameScannedRegularFile', () => {
  it('uses EISDIR for delete attempts against directories', () => {
    expect(() =>
      assertSameScannedRegularFile(
        {
          dev: 1,
          ino: 1,
          mtimeMs: 0,
          ctimeMs: 0,
          size: 0,
          isFile: () => false,
        },
        {
          relativePath: 'dir',
          absolutePath: 'dir',
          modTimeMillis: 0,
          size: 0,
        },
        'delete',
      ),
    ).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  })
})
