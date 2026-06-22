import { describe, expect, it } from 'vitest'
import { safeRelativePathSegments } from './path-safety.ts'

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
    'con.txt',
    'NUL',
    'COM1.log',
    'LPT9',
    'trailing-dot.',
    'trailing-space ',
  ])('rejects unsafe local destination path %s', (relPath) => {
    expect(() => safeRelativePathSegments(relPath)).toThrow('unsafe local destination path')
  })
})
