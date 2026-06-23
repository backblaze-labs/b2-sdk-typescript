import { describe, expect, it } from 'vitest'
import {
  assertPathInsideRoot,
  hasErrorCode,
  makeReservedSyncTempFileName,
  noFollowFlag,
  safeRelativePathSegments,
} from './path-safety.ts'

describe('safeRelativePathSegments', () => {
  it('accepts ordinary relative B2 names', () => {
    expect(safeRelativePathSegments('safe/path.txt')).toEqual(['safe', 'path.txt'])
    expect(safeRelativePathSegments('..safe/.hidden')).toEqual(['..safe', '.hidden'])
  })

  it.each([
    '',
    '/absolute.txt',
    'C:/windows.txt',
    '../outside.txt',
    'nested/../outside.txt',
    'nested//file.txt',
    'nested\\file.txt',
    'report.txt:hidden',
    'CON',
    'CONIN$',
    'CONOUT$',
    'con.txt',
    'NUL',
    'COM0',
    'COM0.txt',
    'COM1.log',
    'COM\u00b9.log',
    'LPT0',
    'LPT0.txt',
    'LPT\u00b2',
    'LPT9',
    'trailing-dot.',
    'trailing-space ',
  ])('rejects unsafe local destination path %s', (relPath) => {
    expect(() => safeRelativePathSegments(relPath)).toThrow('unsafe local destination path')
  })

  it('rejects SDK-reserved temporary file names', () => {
    const tempName = makeReservedSyncTempFileName(
      'payload.bin',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    )

    expect(() => safeRelativePathSegments(`nested/${tempName}`)).toThrow(
      'reserved SDK temporary-file name',
    )
  })
})

describe('assertPathInsideRoot', () => {
  it('accepts child paths and rejects root or outside paths', () => {
    const pathApi = {
      sep: '/',
      relative(root: string, target: string) {
        if (target === root) return ''
        if (target.startsWith(`${root}/`)) return target.slice(root.length + 1)
        return `../${target.replace(/^\/+/, '')}`
      },
      isAbsolute(value: string) {
        return value.startsWith('/')
      },
    } as Parameters<typeof assertPathInsideRoot>[2]
    const root = '/sync-root'

    expect(() => assertPathInsideRoot(root, `${root}/file.txt`, pathApi)).not.toThrow()
    expect(() => assertPathInsideRoot(root, root, pathApi)).toThrow('unsafe local destination path')
    expect(() => assertPathInsideRoot(root, '/outside-root', pathApi)).toThrow(
      'unsafe local destination path',
    )
  })
})

describe('filesystem error helpers', () => {
  it('returns no-follow flags and detects error codes', () => {
    expect(noFollowFlag({ O_NOFOLLOW: 123 })).toBe(123)
    expect(noFollowFlag({})).toBe(0)
    expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(true)
    expect(hasErrorCode({ code: 'EACCES' }, 'ENOENT')).toBe(false)
  })
})
