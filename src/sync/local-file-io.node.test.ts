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
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_STAGING_DIRECTORY_NAME,
  DOWNLOAD_STAGING_MARKER_NAME,
} from './download-staging.ts'
import {
  deleteLocalFileInsideRoot,
  localFileIoTestHooks,
  writeLocalFileInsideRoot,
  writeLocalStreamInsideRoot,
} from './local-file-io.ts'

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

  it('reaps stale SDK-owned staging directories before creating a new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-local-file-stale-stage-'))
    try {
      const managedDirectory = join(root, DOWNLOAD_STAGING_DIRECTORY_NAME)
      const staleDirectory = join(managedDirectory, '2000-01-01-old.download')
      const unmarkedDirectory = join(managedDirectory, '2000-01-01-unmarked.download')
      await mkdir(staleDirectory, { recursive: true, mode: 0o700 })
      await mkdir(unmarkedDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(staleDirectory, '.b2sdk-staging-marker'), '')
      await writeFile(join(staleDirectory, 'partial.bin'), 'old')
      await writeFile(join(unmarkedDirectory, 'partial.bin'), 'keep')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
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
      await mkdir(staleDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(staleDirectory, DOWNLOAD_STAGING_MARKER_NAME), '')
      await writeFile(join(staleDirectory, 'partial.bin'), 'old')
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
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
        await mkdir(directory)
        await writeFile(join(directory, '.b2sdk-staging-marker'), '')
        await writeFile(join(directory, 'payload.bin'), 'stale')
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

  it('fails closed when anchored deletion is unavailable', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'b2sdk-local-file-delete-unavailable-')),
    )
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    try {
      const scannedPath = await makeScannedPath(root, 'victim.txt', 'delete-me')
      Object.defineProperty(process, 'platform', { value: 'darwin' })

      await expect(deleteLocalFileInsideRoot(root, scannedPath)).rejects.toThrow(
        'unsafe local delete path: anchored deletion is not available',
      )
      await expect(readFile(scannedPath.absolutePath, 'utf8')).resolves.toBe('delete-me')
    } finally {
      if (platformDescriptor !== undefined) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
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
