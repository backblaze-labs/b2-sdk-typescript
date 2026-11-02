#!/usr/bin/env node
// Changelog gate for changie fragments (see CONTRIBUTING.md#changelog-entries).
//
//   node scripts/check-changelog.mjs --lint
//     Part of `pnpm verify`. Every pending `.changes/unreleased/*.yaml` must
//     parse, and CHANGELOG.md must equal what `changie merge` produces from
//     `.changes/` (so nobody hand-edits the generated file).
//
//   node scripts/check-changelog.mjs
//     The `changelog` PR check. Runs the lint, then requires a branch that
//     changes non-test source under `src/` to add a fragment (or a release's
//     `.changes/v*.md`). Compares against BASE_REF (default `origin/main`).
//     The workflow skips PRs labeled `skip-changelog`.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot, runChangie } from './changie.mjs'

/**
 * Whether the changed paths include user-facing SDK source.
 *
 * @param {string[]} changedFiles - repo-relative paths changed by the branch.
 * @returns {boolean} true when a changelog fragment is required.
 */
export function needsFragment(changedFiles) {
  return changedFiles.some(
    (f) => f.startsWith('src/') && !f.endsWith('.test.ts') && !f.startsWith('src/test-utils/'),
  )
}

/**
 * Whether the added paths include a changelog entry.
 *
 * @param {string[]} addedFiles - repo-relative paths added by the branch.
 * @returns {boolean} true for a new fragment or a release version file.
 */
export function addsFragment(addedFiles) {
  return addedFiles.some(
    (f) => /^\.changes\/unreleased\/[^/]+\.yaml$/.test(f) || /^\.changes\/v[^/]+\.md$/.test(f),
  )
}

/**
 * Validate the committed `.changes/` against CHANGELOG.md.
 *
 * @returns {string[]} error messages; empty when everything is consistent.
 */
export function lint() {
  const errors = []
  const pending = readdirSync(join(repoRoot, '.changes', 'unreleased')).filter((f) =>
    f.endsWith('.yaml'),
  )
  if (pending.length > 0) {
    const batch = runChangie(['batch', 'auto', '--dry-run'], { capture: true })
    if (batch.status !== 0) {
      errors.push(`changie could not parse .changes/unreleased:\n${batch.stderr || batch.stdout}`)
    }
  }
  const merged = runChangie(['merge', '--dry-run'], { capture: true })
  if (merged.status !== 0) {
    errors.push(`changie merge failed:\n${merged.stderr || merged.stdout}`)
  } else {
    const current = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')
    if (merged.stdout.trimEnd() !== current.trimEnd()) {
      errors.push(
        'CHANGELOG.md is not generated from .changes/. Edit .changes/ (a fragment, a .changes/v*.md, or header.tpl.md), then run `pnpm exec changie merge`.',
      )
    }
  }
  return errors
}

function gitPaths(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function main() {
  const errors = lint()
  if (!process.argv.includes('--lint')) {
    const base = process.env.BASE_REF || 'origin/main'
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', base], { cwd: repoRoot })
    } catch {
      console.error(
        `check-changelog: BASE_REF ${base} not found; run 'git fetch origin' or set BASE_REF.`,
      )
      process.exit(1)
    }
    const changed = gitPaths(['diff', '--name-only', `${base}...HEAD`])
    const added = gitPaths(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`])
    if (needsFragment(changed) && !addsFragment(added)) {
      errors.push(
        'No changelog entry: this branch changes src/ but adds no .changes/unreleased fragment. Run `pnpm run changelog:new` (or label the PR skip-changelog if it is not user-visible).',
      )
    }
  }
  for (const error of errors) console.error(`check-changelog: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log('check-changelog: OK')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
