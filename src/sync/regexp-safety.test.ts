import { describe, expect, it } from 'vitest'
import {
  pathExceedsSafeRegExpInput,
  regexpMatchesSyncPath,
  validateSyncFilters,
} from './regexp-safety.ts'
import type { SyncFilterOptions } from './types.ts'

describe('sync regexp safety', () => {
  it('reports the include or exclude filter that failed validation', () => {
    expect(() => validateSyncFilters({ exclude: [/x.*.*y/] })).toThrow(
      'Sync filter RegExp is too complex (exclude:',
    )
  })

  it('memoizes validation per filter object identity', () => {
    let reads = 0
    const filters = new Proxy(
      { include: [/\.txt$/], exclude: ['*.tmp'] } satisfies SyncFilterOptions,
      {
        get(target, property, receiver) {
          if (property === 'include' || property === 'exclude') reads++
          return Reflect.get(target, property, receiver)
        },
      },
    )

    validateSyncFilters(filters)
    const readsAfterFirstValidation = reads
    validateSyncFilters(filters)

    expect(readsAfterFirstValidation).toBeGreaterThan(0)
    expect(reads).toBe(readsAfterFirstValidation)
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

  it('rejects nested quantified groups before matching paths', () => {
    const nestedAlpha = /((a+)){30}/
    const nestedDigits = /(([0-9]+)){30}/
    const nestedAlternation = /((a|b)){30}/

    expect(() => validateSyncFilters({ include: [nestedAlpha] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => validateSyncFilters({ include: [nestedDigits] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => validateSyncFilters({ include: [nestedAlternation] })).toThrow(
      'Sync filter RegExp is too complex',
    )
  })

  it('rejects high-cardinality bounded quantifiers', () => {
    const tooLargeBound = /a{100000}/
    const nestedLargeBound = /((a+)){500}/
    const repeatedBounds = new RegExp('^'.concat('a{0,1000}'.repeat(5), 'b$'))

    expect(() => validateSyncFilters({ include: [tooLargeBound] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => validateSyncFilters({ include: [nestedLargeBound] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => validateSyncFilters({ include: [repeatedBounds] })).toThrow(
      'Sync filter RegExp is too complex',
    )
  })

  it('treats malformed brace quantifiers as literals', () => {
    const openBrace = /a{/
    const namedBrace = /a{b}/

    expect(() => validateSyncFilters({ include: [openBrace, namedBrace] })).not.toThrow()
    expect(regexpMatchesSyncPath('a{', openBrace)).toBe(true)
    expect(regexpMatchesSyncPath('a{b}', namedBrace)).toBe(true)
  })
})
