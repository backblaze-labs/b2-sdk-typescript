#!/usr/bin/env node
// Print the CHANGELOG.md section for a given version to stdout, so the release
// workflow can use it as the GitHub Release body.
//
// Usage: node scripts/extract-changelog.mjs <version>
//   e.g. node scripts/extract-changelog.mjs 0.1.0
//
// Prints everything between `## [<version>]` and the next `## [` heading
// (exclusive), trimmed. Exits non-zero if the section isn't found so the
// release workflow fails loudly rather than publishing an empty-bodied release.

import { existsSync, promises as fs, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runChangie } from './changie.mjs'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/extract-changelog.mjs <version>')
  process.exit(1)
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = await fs.readFile(join(repo, 'CHANGELOG.md'), 'utf8')

const isPrerelease = version.includes('-')

function sectionBody(headingRe) {
  const m = headingRe.exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const nextRel = rest.search(/^## \[/m)
  // Drop changie's per-version compare-link definitions; they are invisible in a release body.
  return (nextRel === -1 ? rest : rest.slice(0, nextRel))
    .split('\n')
    .filter((line) => !/^\[[^\]]+\]: /.test(line))
    .join('\n')
    .trim()
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
let body = sectionBody(new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm'))

// Prereleases don't get their own changelog section (cut-changelog skips them),
// so render the unreleased changie fragments that describe the upcoming release.
if ((body === null || body === '') && isPrerelease) {
  body = unreleasedNotes(version) || `Prerelease ${version}.`
}

function unreleasedNotes(v) {
  const dir = join(repo, '.changes', 'unreleased')
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('.yaml'))) return ''
  // Fragments exist, so a changie failure (e.g. a malformed fragment) must fail the release.
  const { status, stdout, stderr } = runChangie(['batch', `v${v}`, '--dry-run'], { capture: true })
  if (status !== 0) {
    console.error(
      `extract-changelog: changie could not render the unreleased fragments.\n${stderr}`,
    )
    process.exit(status)
  }
  return stdout
    .split('\n')
    .filter((line) => !/^## \[/.test(line) && !/^\[[^\]]+\]: /.test(line))
    .join('\n')
    .trim()
}

if (body === null) {
  console.error(`extract-changelog: no "## [${version}]" section found in CHANGELOG.md.`)
  process.exit(1)
}
if (body === '') {
  console.error(`extract-changelog: the "## [${version}]" section is empty.`)
  process.exit(1)
}

process.stdout.write(`${body}\n`)
