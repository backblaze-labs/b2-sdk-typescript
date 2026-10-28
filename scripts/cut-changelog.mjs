#!/usr/bin/env node
// Batch the unreleased changie fragments into a dated, versioned changelog
// section. Run automatically by the `version` lifecycle script during
// `pnpm version <patch|minor|major>`, after package.json's version is bumped
// but before the version commit + tag are created, so the regenerated
// CHANGELOG.md and `.changes/` land in the same commit the tag points at.
//
// Contributors add one fragment per change with `pnpm run changelog:new`
// (files under `.changes/unreleased/`); the release collects them.
//
// What it does, given the freshly bumped `version` from package.json:
//   1. `changie batch v<version>` writes `.changes/v<version>.md` (dated
//      `## [<version>]` section plus its compare link) and deletes the
//      batched fragments.
//   2. `changie merge` regenerates CHANGELOG.md from `.changes/header.tpl.md`
//      and every `.changes/v*.md`.
//   3. Warns loudly (but does not fail) when there were no fragments, so you
//      notice a release with no notes rather than shipping silence.

import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot, runChangie } from './changie.mjs'

const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const version = pkg.version

// Prereleases (0.5.0-rc.0, etc.) leave the fragments alone: they describe the
// eventual *stable* release, so a prerelease must not consume them. The
// stable bump later batches them as usual.
if (version.includes('-')) {
  console.log(`cut-changelog: ${version} is a prerelease; leaving .changes/unreleased intact.`)
  process.exit(0)
}

if (existsSync(join(repoRoot, '.changes', `v${version}.md`))) {
  console.error(`cut-changelog: .changes/v${version}.md already exists. Nothing to do.`)
  process.exit(1)
}

const fragments = readdirSync(join(repoRoot, '.changes', 'unreleased')).filter((f) =>
  f.endsWith('.yaml'),
)
if (fragments.length === 0) {
  console.warn(
    `cut-changelog: WARNING: .changes/unreleased has no fragments. Releasing v${version} with no changelog notes. Add entries with \`pnpm run changelog:new\` before tagging if this is unintended.`,
  )
}

for (const args of [['batch', `v${version}`], ['merge']]) {
  const { status } = runChangie(args)
  if (status !== 0) {
    console.error(`cut-changelog: \`changie ${args.join(' ')}\` failed (exit ${status}).`)
    process.exit(status)
  }
}

console.log(`cut-changelog: batched ${fragments.length} fragment(s) into [${version}]`)
