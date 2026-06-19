import { describe, expect, it } from 'vitest'
import {
  directoryMayContainSyncPaths,
  filterSyncPaths,
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
    expect(pathPassesSyncFilters('', { include: [''] })).toBe(true)
    expect(pathPassesSyncFilters('', { include: ['docs/readme.md'] })).toBe(false)
    expect(pathPassesSyncFilters('readme.md', { include: ['readme.*'] })).toBe(true)
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

  it('accepts safe non-capturing regular expression filters', () => {
    expect(pathPassesSyncFilters('abab', { include: [/(?:ab)+/] })).toBe(true)
    expect(pathPassesSyncFilters('aba', { include: [/^(?:ab)+$/] })).toBe(false)
    expect(pathPassesSyncFilters('abc', { include: [/^[a-c]+$/] })).toBe(true)
    expect(pathPassesSyncFilters('a', { include: [/^a?$/] })).toBe(true)
    expect(pathPassesSyncFilters('aaaa', { include: [/^a{2,4}$/] })).toBe(true)
    expect(pathPassesSyncFilters('aaaaa', { include: [/^a{2,4}$/] })).toBe(false)
  })

  it('rejects structurally unsafe regular expression filters', () => {
    const unsafePattern = new RegExp('(a+)'.concat('+$'))
    const namedBackreference = new RegExp('(?<word>a+)'.concat('\\k<word>'))
    const numberedBackreference = new RegExp('(a)'.concat('\\1'))
    const quantifiedAlternation = /(a|b)+/
    const tooLongPattern = new RegExp('a'.repeat(513))
    const tooManyUnboundedQuantifiers = new RegExp('^'.concat('a{1,}'.repeat(9), 'b$'))

    expect(() =>
      pathPassesSyncFilters('aaaaaaaaaaaaaaaaaaaa', { include: [unsafePattern] }),
    ).toThrow('Sync filter RegExp is too complex')
    expect(() => pathPassesSyncFilters('aaaa', { include: [namedBackreference] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => pathPassesSyncFilters('aa', { include: [numberedBackreference] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => pathPassesSyncFilters('a', { include: [quantifiedAlternation] })).toThrow(
      'Sync filter RegExp is too complex',
    )
    expect(() => pathPassesSyncFilters('a', { include: [tooLongPattern] })).toThrow(
      'Sync filter RegExp is too long',
    )
    expect(() =>
      pathPassesSyncFilters('aaaaaaaaab', { include: [tooManyUnboundedQuantifiers] }),
    ).toThrow('Sync filter RegExp is too complex')
  })

  it('normalizes path separators and simple dot prefixes', () => {
    expect(pathPassesSyncFilters('/docs\\readme.md', { include: ['./docs/readme.md/'] })).toBe(true)
  })

  it('checks whether directories may contain included paths', () => {
    expect(directoryMayContainSyncPaths('', { include: ['docs/**'] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: [/^docs\//] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: [''] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: ['readme.md'] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: ['docs/readme.md'] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: ['d*/readme.md'] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: ['**/readme.md'] })).toBe(true)
    expect(directoryMayContainSyncPaths('docs', { include: ['src/readme.md'] })).toBe(false)
  })

  it('filters async sync path iterables', async () => {
    async function* paths() {
      yield { relativePath: 'keep.txt', modTimeMillis: 1, size: 1 }
      yield { relativePath: 'skip.txt', modTimeMillis: 1, size: 1 }
      yield { relativePath: 'keep.bin', modTimeMillis: 1, size: 1 }
    }

    const kept: string[] = []
    for await (const path of filterSyncPaths(paths(), {
      include: ['*.txt'],
      exclude: ['skip.txt'],
    })) {
      kept.push(path.relativePath)
    }

    expect(kept).toEqual(['keep.txt'])
  })

  it('computes safe literal B2 prefixes for include filters', () => {
    expect(literalPrefixForSyncFilters({ include: ['active/**'] })).toBe('active/')
    expect(literalPrefixForSyncFilters({ include: ['active/a.txt', 'active/b.txt'] })).toBe(
      'active/',
    )
    expect(
      literalPrefixForSyncFilters({
        include: ['emoji/\u{1f600}.txt', 'emoji/\u{1f603}.txt'],
      }),
    ).toBe('emoji/')
    expect(literalPrefixForSyncFilters({ include: ['readme.md'] })).toBe('')
    expect(literalPrefixForSyncFilters({ include: [/^active\//] })).toBe('')
  })
})
