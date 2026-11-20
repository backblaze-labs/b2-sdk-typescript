// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static text checks over repository files. They skip (not fail) outside a full checkout.
const repoRoot = resolve(import.meta.dirname, '../..')
const changelogPath = resolve(repoRoot, 'CHANGELOG.md')

describe('CHANGELOG', () => {
  it.skipIf(!existsSync(changelogPath))(
    'every Fixed entry of the Unreleased section links its issue or PR',
    () => {
      const lines = readFileSync(changelogPath, 'utf8').split('\n')
      const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
      expect(start, 'CHANGELOG.md has an [Unreleased] section').not.toBe(-1)
      const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
      const body = lines.slice(start + 1, end === -1 ? lines.length : end)
      const fixedAt = body.findIndex((l) => l.trim() === '### Fixed')
      expect(fixedAt, 'the Unreleased section has a Fixed heading').not.toBe(-1)
      const next = body.findIndex((l, i) => i > fixedAt && l.startsWith('### '))
      const entries = body
        .slice(fixedAt + 1, next === -1 ? body.length : next)
        .join('\n')
        .split(/\n(?=- )/)
        .filter((e) => e.trim().startsWith('- '))
      expect(entries.length, 'the Fixed section has entries').toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry, `Fixed entry has no issue/PR reference: ${entry.slice(0, 80)}...`).toMatch(
          /#\d+|\/(?:issues|pull)\/\d+/,
        )
      }
    },
  )
})
