import { describe, expect, it } from 'vitest'
import {
  directoryMayContainSyncPaths,
  literalPrefixForSyncFilters,
  pathPassesSyncFilters,
} from './filters.ts'

describe('sync filters', () => {
  it('excludes files under bare directory-name patterns', () => {
    const excludedDirs = [
      ['.git', '.git/config'],
      ['secrets', 'secrets/prod.key'],
      ['.ssh', '.ssh/id_rsa'],
      ['node_modules', 'node_modules/.bin/tool'],
    ] as const

    for (const [pattern, path] of excludedDirs) {
      expect(pathPassesSyncFilters(path, { exclude: [pattern] })).toBe(false)
      expect(directoryMayContainSyncPaths(pattern, { exclude: [pattern] })).toBe(false)
    }
  })

  it('matches slash-less literals at any path depth', () => {
    expect(pathPassesSyncFilters('docs/readme.md', { include: ['readme.md'] })).toBe(true)
    expect(pathPassesSyncFilters('docs/guide.md', { include: ['readme.md'] })).toBe(false)
  })

  it('evaluates pathological glob patterns without regex backtracking', () => {
    const glob = `${'**a'.repeat(64)}Z`
    const start = performance.now()

    expect(pathPassesSyncFilters('a'.repeat(512), { include: [glob] })).toBe(false)

    expect(performance.now() - start).toBeLessThan(1000)
  })

  it('does not retain state when matching regular expression filters', () => {
    const globalPattern = /\.txt$/g
    globalPattern.lastIndex = 3

    expect(pathPassesSyncFilters('a.txt', { include: [globalPattern] })).toBe(true)
    expect(pathPassesSyncFilters('b.txt', { include: [globalPattern] })).toBe(true)
    expect(globalPattern.lastIndex).toBe(3)

    expect(pathPassesSyncFilters('c.txt', { include: [/\.txt$/] })).toBe(true)
    expect(pathPassesSyncFilters('c.bin', { include: [/\.txt$/] })).toBe(false)
  })

  it('rejects structurally unsafe regular expression filters', () => {
    expect(() => pathPassesSyncFilters('aaaaaaaaaaaaaaaaaaaa', { include: [/(a+)+$/] })).toThrow(
      'Sync filter RegExp is too complex',
    )
  })

  it('computes safe literal B2 prefixes for include filters', () => {
    expect(literalPrefixForSyncFilters({ include: ['active/**'] })).toBe('active/')
    expect(literalPrefixForSyncFilters({ include: ['active/a.txt', 'active/b.txt'] })).toBe(
      'active/',
    )
    expect(literalPrefixForSyncFilters({ include: ['readme.md'] })).toBe('')
    expect(literalPrefixForSyncFilters({ include: [/^active\//] })).toBe('')
  })
})
