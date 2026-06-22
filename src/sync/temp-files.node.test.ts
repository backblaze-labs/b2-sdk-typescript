import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSyncDownloadTempFileSweeper,
  isOwnedSyncDownloadTempName,
  isSyncDownloadTempName,
  removeSyncDownloadTempFiles,
  syncDownloadTempName,
} from './temp-files.ts'

describe('sync temp files', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'b2sdk-sync-temp-files-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('matches SDK-managed partial download names', () => {
    expect(isSyncDownloadTempName('.b2sdk-active.partial')).toBe(true)
    expect(isSyncDownloadTempName('.b2sdk-active.tmp')).toBe(false)
    expect(isSyncDownloadTempName('active.partial')).toBe(false)
    expect(isOwnedSyncDownloadTempName('.b2sdk-run-active.partial', 'run')).toBe(true)
    expect(isOwnedSyncDownloadTempName('.b2sdk-other-active.partial', 'run')).toBe(false)
  })

  it('removes only owned SDK partial download files from a directory', async () => {
    const partialPath = join(tmpDir, syncDownloadTempName('run', 'abandoned'))
    const otherPartialPath = join(tmpDir, syncDownloadTempName('other', 'active'))
    const keepPath = join(tmpDir, 'keep.txt')
    await writeFile(partialPath, 'partial')
    await writeFile(otherPartialPath, 'other')
    await writeFile(keepPath, 'keep')

    await removeSyncDownloadTempFiles(tmpDir, 'run')

    await expect(access(partialPath)).rejects.toThrow()
    await expect(access(otherPartialPath)).resolves.toBeUndefined()
    await expect(access(keepPath)).resolves.toBeUndefined()
  })

  it('does not remove directories with SDK partial download names', async () => {
    const partialDir = join(tmpDir, '.b2sdk-directory.partial')
    await mkdir(partialDir)

    await removeSyncDownloadTempFiles(tmpDir, 'run')

    await expect(access(partialDir)).resolves.toBeUndefined()
  })

  it('ignores missing directories', async () => {
    await expect(
      removeSyncDownloadTempFiles(join(tmpDir, 'missing'), 'run'),
    ).resolves.toBeUndefined()
  })

  it('sweeps a directory once per sweeper', async () => {
    const firstPartialPath = join(tmpDir, syncDownloadTempName('run', 'first'))
    const secondPartialPath = join(tmpDir, syncDownloadTempName('run', 'second'))
    const removeSyncDownloadTempFilesOnce = createSyncDownloadTempFileSweeper('run')
    await writeFile(firstPartialPath, 'first')

    await removeSyncDownloadTempFilesOnce(tmpDir)
    await writeFile(secondPartialPath, 'second')
    await removeSyncDownloadTempFilesOnce(tmpDir)

    await expect(access(firstPartialPath)).rejects.toThrow()
    await expect(access(secondPartialPath)).resolves.toBeUndefined()
  })

  it('does not share sweep state across sweepers', async () => {
    const firstPartialPath = join(tmpDir, syncDownloadTempName('run', 'first'))
    const secondPartialPath = join(tmpDir, syncDownloadTempName('run', 'second'))
    await writeFile(firstPartialPath, 'first')

    await createSyncDownloadTempFileSweeper('run')(tmpDir)
    await writeFile(secondPartialPath, 'second')
    await createSyncDownloadTempFileSweeper('run')(tmpDir)

    await expect(access(firstPartialPath)).rejects.toThrow()
    await expect(access(secondPartialPath)).rejects.toThrow()
  })

  it('retries sweeps after a failed sweep', async () => {
    vi.resetModules()
    const readdir = vi
      .fn()
      .mockResolvedValue([{ isFile: () => true, name: syncDownloadTempName('run', 'locked') }])
    const rm = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce(undefined)
    vi.doMock('node:fs/promises', () => ({ readdir, rm }))
    try {
      const tempFiles = await import('./temp-files.ts')
      const removeSyncDownloadTempFilesOnce = tempFiles.createSyncDownloadTempFileSweeper('run')

      await expect(removeSyncDownloadTempFilesOnce('/tmp/mock')).rejects.toThrow('locked')
      await expect(removeSyncDownloadTempFilesOnce('/tmp/mock')).resolves.toBeUndefined()
      expect(rm).toHaveBeenCalledTimes(2)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})
