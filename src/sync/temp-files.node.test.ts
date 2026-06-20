import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isSyncDownloadTempName,
  removeSyncDownloadTempFiles,
  removeSyncDownloadTempFilesOnce,
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
  })

  it('removes SDK-managed partial download files from a directory', async () => {
    const partialPath = join(tmpDir, '.b2sdk-abandoned.partial')
    const keepPath = join(tmpDir, 'keep.txt')
    await writeFile(partialPath, 'partial')
    await writeFile(keepPath, 'keep')

    await removeSyncDownloadTempFiles(tmpDir)

    await expect(access(partialPath)).rejects.toThrow()
    await expect(access(keepPath)).resolves.toBeUndefined()
  })

  it('does not remove directories with SDK partial download names', async () => {
    const partialDir = join(tmpDir, '.b2sdk-directory.partial')
    await mkdir(partialDir)

    await removeSyncDownloadTempFiles(tmpDir)

    await expect(access(partialDir)).resolves.toBeUndefined()
  })

  it('ignores missing directories', async () => {
    await expect(removeSyncDownloadTempFiles(join(tmpDir, 'missing'))).resolves.toBeUndefined()
  })

  it('sweeps a directory once per process', async () => {
    const firstPartialPath = join(tmpDir, '.b2sdk-first.partial')
    const secondPartialPath = join(tmpDir, '.b2sdk-second.partial')
    await writeFile(firstPartialPath, 'first')

    await removeSyncDownloadTempFilesOnce(tmpDir)
    await writeFile(secondPartialPath, 'second')
    await removeSyncDownloadTempFilesOnce(tmpDir)

    await expect(access(firstPartialPath)).rejects.toThrow()
    await expect(access(secondPartialPath)).resolves.toBeUndefined()
  })

  it('retries once-per-process sweeps after a failed sweep', async () => {
    vi.resetModules()
    const readdir = vi
      .fn()
      .mockResolvedValue([{ isFile: () => true, name: '.b2sdk-locked.partial' }])
    const rm = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce(undefined)
    vi.doMock('node:fs/promises', () => ({ readdir, rm }))
    try {
      const tempFiles = await import('./temp-files.ts')

      await expect(tempFiles.removeSyncDownloadTempFilesOnce('/tmp/mock')).rejects.toThrow('locked')
      await expect(tempFiles.removeSyncDownloadTempFilesOnce('/tmp/mock')).resolves.toBeUndefined()
      expect(rm).toHaveBeenCalledTimes(2)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})
