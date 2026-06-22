import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSafeLocalWritePath } from './paths.ts'

describe('sync local write path safety', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'b2sdk-sync-paths-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects an empty local root', async () => {
    await expect(resolveSafeLocalWritePath('', 'file.txt')).rejects.toThrow(
      'Sync local root is required for downloads.',
    )
  })

  it('creates missing parent directories before returning the write path', async () => {
    const destPath = await resolveSafeLocalWritePath(tmpDir, 'nested/deep/file.txt')

    expect(destPath).toBe(join(tmpDir, 'nested', 'deep', 'file.txt'))
  })
})
