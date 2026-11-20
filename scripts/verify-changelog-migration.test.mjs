// Regression check for the migration guide.
// Run with: node --test scripts/verify-changelog-migration.test.mjs
// (also part of `pnpm run verify:docs-consistency`).
//
// The check asserts on document text, so it is intentionally narrow: it skips
// when MIGRATION.md is not available (for example in a source tarball),
// instead of failing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

test('MIGRATION.md does not say there is no narrower retry option while documenting one', (t) => {
  if (!existsSync(join(repoRoot, 'MIGRATION.md'))) {
    t.skip('MIGRATION.md is not present in this checkout')
    return
  }
  const migration = read('MIGRATION.md')
  assert.match(
    migration,
    /retryUploadConnectionFaults/,
    'precondition: the narrower option is documented',
  )
  assert.doesNotMatch(
    migration,
    /no narrower per-fault\s+option/i,
    'MIGRATION.md says there is no narrower per-fault option, but a later section documents retryUploadConnectionFaults: false',
  )
})
