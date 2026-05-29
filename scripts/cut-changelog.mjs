#!/usr/bin/env node
// Promote the `## [Unreleased]` section of CHANGELOG.md into a dated, versioned
// section. Run automatically by the `version` lifecycle script during
// `pnpm version <patch|minor|major>` — after package.json's version is bumped
// but before the version commit + tag are created, so the rewritten CHANGELOG
// lands in the same commit the tag points at.
//
// Contributors keep notes under `## [Unreleased]` (Keep a Changelog style) as
// they land PRs; the release dates and renames that section.
//
// What it does, given the freshly-bumped `version` from package.json:
//   1. Renames `## [Unreleased]` -> `## [<version>] - <YYYY-MM-DD>`, leaving a
//      fresh empty `## [Unreleased]` above it.
//   2. Rewrites the link-reference footer: points `[Unreleased]` at
//      `v<version>...HEAD` and inserts `[<version>]` comparing the previous
//      release to this one (or a release tag link when there's no prior).
//   3. Warns loudly (but does not fail) if the Unreleased section was empty,
//      so you notice a release with no notes rather than shipping silence.
//
// Repo URL is derived from package.json `repository.url`, so a future rename
// doesn't strand the links.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const changelogPath = join(repo, 'CHANGELOG.md')

const pkg = JSON.parse(await fs.readFile(join(repo, 'package.json'), 'utf8'))
const version = pkg.version
const repoUrl = (pkg.repository?.url ?? '').replace(/\.git$/, '').replace(/\/$/, '')
if (!repoUrl) {
  console.error(
    'cut-changelog: package.json repository.url is missing; cannot build compare links.',
  )
  process.exit(1)
}

// Prereleases (0.2.0-rc.0, etc.) leave the changelog alone: the `[Unreleased]`
// notes describe the eventual *stable* release, so we don't want a prerelease
// to consume them. The stable cut later promotes them as usual.
if (version.includes('-')) {
  console.log(`cut-changelog: ${version} is a prerelease; leaving [Unreleased] intact.`)
  process.exit(0)
}

const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
let text = await fs.readFile(changelogPath, 'utf8')

// --- Guard: a `## [<version>]` heading must not already exist (idempotency /
// double-run protection).
if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) {
  console.error(
    `cut-changelog: CHANGELOG.md already has a "## [${version}]" section. Nothing to do.`,
  )
  process.exit(1)
}

// --- Locate the Unreleased section: from `## [Unreleased]` up to the next
// `## [` heading (or end of file / link-ref footer).
const unreleasedRe = /^## \[Unreleased\]\s*$/m
const m = unreleasedRe.exec(text)
if (!m) {
  console.error('cut-changelog: no "## [Unreleased]" heading found in CHANGELOG.md.')
  process.exit(1)
}
const sectionStart = m.index + m[0].length
const nextHeadingRe = /^## \[/m
nextHeadingRe.lastIndex = sectionStart
const rest = text.slice(sectionStart)
const nextRel = rest.search(/^## \[/m)
const sectionEnd = nextRel === -1 ? text.length : sectionStart + nextRel
const unreleasedBody = text.slice(sectionStart, sectionEnd).trim()

if (unreleasedBody === '') {
  console.warn(
    `cut-changelog: WARNING — the [Unreleased] section is empty. Releasing v${version} with no changelog notes. Add entries under "## [Unreleased]" before tagging if this is unintended.`,
  )
}

// --- Find the previous released version (first `## [x.y.z]` after Unreleased)
// for the compare link.
const prevMatch = /^## \[(\d+\.\d+\.\d+[^\]]*)\]/m.exec(rest)
const prevVersion = prevMatch ? prevMatch[1] : null

// --- Rebuild the top: fresh empty Unreleased, then the dated version section.
const before = text.slice(0, m.index)
const promoted = unreleasedBody ? `${unreleasedBody}\n\n` : ''
const newTop = `## [Unreleased]\n\n## [${version}] - ${date}\n\n${promoted}`
const afterSection = text.slice(sectionEnd)
text = `${before}${newTop}${afterSection}`

// --- Rewrite link-reference footer.
const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`
const versionLink = prevVersion
  ? `[${version}]: ${repoUrl}/compare/v${prevVersion}...v${version}`
  : `[${version}]: ${repoUrl}/releases/tag/v${version}`

if (/^\[Unreleased\]:.*$/m.test(text)) {
  text = text.replace(/^\[Unreleased\]:.*$/m, `${unreleasedLink}\n${versionLink}`)
} else {
  // No footer yet — append one.
  text = `${text.replace(/\s*$/, '')}\n\n${unreleasedLink}\n${versionLink}\n`
}

await fs.writeFile(changelogPath, text)
console.log(`cut-changelog: promoted [Unreleased] -> [${version}] - ${date}`)
