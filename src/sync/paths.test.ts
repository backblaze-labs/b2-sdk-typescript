import { describe, expect, it } from 'vitest'
import { assertSyncPathAllowed, resolveSafeLocalPath } from './paths.ts'

const posixPath = {
  isAbsolute(path: string): boolean {
    return path.startsWith('/')
  },
  resolve(...paths: string[]): string {
    const raw = paths.join('/')
    const absolute = raw.startsWith('/')
    const parts: string[] = []
    for (const part of raw.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        parts.pop()
        continue
      }
      parts.push(part)
    }
    return `${absolute ? '/' : ''}${parts.join('/')}`
  },
  sep: '/',
}

describe('sync path safety', () => {
  it('resolves sync-relative local paths under the root', () => {
    expect(resolveSafeLocalPath('/sync-root', 'nested/file.txt', posixPath)).toBe(
      '/sync-root/nested/file.txt',
    )
  })

  it('rejects absolute local paths', () => {
    expect(() => resolveSafeLocalPath('/sync-root', '/outside.txt', posixPath)).toThrow(
      'Sync path must be relative',
    )
  })

  it('rejects paths that escape the local root', () => {
    expect(() => resolveSafeLocalPath('/sync-root', '../outside.txt', posixPath)).toThrow(
      'Sync path escapes the local root',
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
