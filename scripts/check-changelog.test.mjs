import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addsFragment, lint, needsFragment } from './check-changelog.mjs'

test('non-test src changes need a fragment; tests, docs and tooling do not', () => {
  assert.equal(needsFragment(['src/client.ts']), true)
  assert.equal(needsFragment(['README.md', 'src/raw/index.ts']), true)
  assert.equal(needsFragment(['src/client.test.ts', 'src/auth/file.node.test.ts']), false)
  assert.equal(needsFragment(['src/test-utils/index.ts']), false)
  assert.equal(needsFragment(['README.md', 'scripts/cut-changelog.mjs', 'package.json']), false)
})

test('a new fragment or a release version file counts as an entry', () => {
  assert.equal(addsFragment(['.changes/unreleased/Fixed-20261027-120001.yaml']), true)
  assert.equal(addsFragment(['.changes/v0.5.0.md']), true)
  assert.equal(
    addsFragment(['.changes/unreleased/.gitkeep', '.changes/header.tpl.md', 'CHANGELOG.md']),
    false,
  )
})

test('committed fragments parse and CHANGELOG.md is generated from .changes/', () => {
  assert.deepEqual(lint(), [])
})
