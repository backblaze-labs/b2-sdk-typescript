import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPathInsideRoot,
  hasErrorCode,
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
    'LPT0',
    'LPT0.txt',
    'LPT9',
    'trailing-dot.',
    'trailing-space ',
  ])('rejects unsafe local destination path %s', (relPath) => {
    expect(() => safeRelativePathSegments(relPath)).toThrow('unsafe local destination path')
  })
})

describe('assertPathInsideRoot', () => {
  it('accepts child paths and rejects root or outside paths', () => {
    const root = path.resolve('sync-root')
    expect(() => assertPathInsideRoot(root, path.join(root, 'file.txt'), path)).not.toThrow()
    expect(() => assertPathInsideRoot(root, root, path)).toThrow('unsafe local destination path')
    expect(() => assertPathInsideRoot(root, path.resolve('outside-root'), path)).toThrow(
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
