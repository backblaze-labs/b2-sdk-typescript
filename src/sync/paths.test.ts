import { posix as posixPath, win32 as win32Path } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSyncPathAllowed, resolveSafeLocalPath } from './paths.ts'

describe('sync path safety', () => {
  it('resolves sync-relative local paths under the root', () => {
    expect(resolveSafeLocalPath('/sync-root', 'nested/file.txt', posixPath)).toBe(
      '/sync-root/nested/file.txt',
    )
  })

  it('resolves paths when the root already ends with a separator', () => {
    expect(resolveSafeLocalPath('/sync-root/', 'nested/file.txt', posixPath)).toBe(
      '/sync-root/nested/file.txt',
    )
  })

  it('resolves paths under the filesystem root', () => {
    expect(resolveSafeLocalPath('/', 'nested/file.txt', posixPath)).toBe('/nested/file.txt')
  })

  it('resolves slash-separated relative paths under a Windows root', () => {
    expect(resolveSafeLocalPath('C:\\sync-root', 'nested/file.txt', win32Path)).toBe(
      'C:\\sync-root\\nested\\file.txt',
    )
  })

  it('rejects absolute local paths', () => {
    expect(() => resolveSafeLocalPath('/sync-root', '/outside.txt', posixPath)).toThrow(
      'Sync path must be relative',
    )
  })

  it.each([
    '../outside.txt',
    'a/../victim',
    './victim',
    'a//b',
    'safe\\..\\victim.txt',
    'C:foo',
  ])('rejects unsafe sync-relative path %j on POSIX', (relativePath) => {
    expect(() => resolveSafeLocalPath('/sync-root', relativePath, posixPath)).toThrow(
      /unsafe local destination path|Sync path must be relative/,
    )
  })

  it.each([
    '../outside.txt',
    'a/../victim',
    './victim',
    'a//b',
    'safe\\..\\victim.txt',
    'C:foo',
    'a:b',
    'CON',
    'nested/LPT1.txt',
  ])('rejects unsafe sync-relative path %j on Windows', (relativePath) => {
    expect(() => resolveSafeLocalPath('C:\\sync-root', relativePath, win32Path)).toThrow(
      /unsafe local destination path|Sync path must be relative/,
    )
  })

  it('rejects the reserved SDK temporary-file namespace', () => {
    expect(() =>
      assertSyncPathAllowed(
        'nested/.b2sdk-0123456789abcdef01234567-pid-0123456789abcdef0123456789abcdef.partial',
      ),
    ).toThrow('reserved SDK temporary-file name')
  })
})
