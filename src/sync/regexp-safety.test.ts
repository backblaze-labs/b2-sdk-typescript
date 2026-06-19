import { describe, expect, it } from 'vitest'
import {
  pathExceedsSafeRegExpInput,
  regexpMatchesSyncPath,
  validateSyncFilters,
} from './regexp-safety.ts'

describe('sync regexp safety', () => {
  it('reports the include or exclude filter that failed validation', () => {
    expect(() => validateSyncFilters({ exclude: [/x.*.*y/] })).toThrow(
      'Sync filter RegExp is too complex (exclude:',
    )
  })

  it('strips stateful flags when matching paths', () => {
    const pattern = /\.txt$/g
    pattern.lastIndex = 3

    expect(regexpMatchesSyncPath('a.txt', pattern)).toBe(true)
    expect(pattern.lastIndex).toBe(3)
  })

  it('bounds the paths fed to caller regular expressions', () => {
    expect(pathExceedsSafeRegExpInput('a'.repeat(1024))).toBe(false)
    expect(pathExceedsSafeRegExpInput('a'.repeat(1025))).toBe(true)
    expect(regexpMatchesSyncPath('a'.repeat(1025), /^a+$/)).toBe(false)
  })
})
