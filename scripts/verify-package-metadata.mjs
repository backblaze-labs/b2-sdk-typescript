#!/usr/bin/env node
// Verify the package.json, README, RELEASE.md, CHANGELOG.md, and src/version.ts
// agree on the package name and version. Run by `pnpm run verify:metadata` and
// before publishing.
//
// The motivation is that a release touches several files (package.json, the
// CHANGELOG entry, the README install snippet, etc.) and it's easy for them to
// drift. This script reads `name` and `version` from package.json and asserts:
//
//   1. Every `npm install` / `pnpm add` / `yarn add` snippet in README.md uses
//      the same scoped package name.
//   2. The README h1 starts with the package name.
//   3. CHANGELOG.md has a `## [<version>]` heading for the current version.
//   4. RELEASE.md's tarball-name examples use `name.replace('/', '-').replace('@', '')`.
//   5. src/version.ts re-exports the version from package.json (no hardcode).
//
// Exits 0 on success, prints a numbered list of mismatches on failure.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

async function read(rel) {
  return await fs.readFile(join(repo, rel), 'utf8')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const pkg = JSON.parse(await read('package.json'))
const { name, version } = pkg
const tarballPrefix = `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}` // e.g. backblaze-labs-b2-sdk-0.1.0

/** @type {string[]} */
const errors = []

// --- README h1
const readme = await read('README.md')
if (!readme.startsWith(`# ${name}\n`)) {
  errors.push(`README.md h1 should be "# ${name}" (found: "${readme.split('\n', 1)[0]}")`)
}

// --- README install snippets
const installMatches = [
  /npm install (@?[^\s`]+)/g,
  /pnpm add (@?[^\s`]+)/g,
  /yarn add (@?[^\s`]+)/g,
]
for (const re of installMatches) {
  for (const m of readme.matchAll(re)) {
    if (m[1] !== name && m[1] !== `${name}@latest` && m[1] !== `${name}@next`) {
      errors.push(`README.md: install snippet "${m[0]}" should reference "${name}"`)
    }
  }
}

// --- README bare imports
const importMatches = readme.matchAll(/from\s+['"](@[^'"/]+\/[^'"]+)['"]/g)
for (const m of importMatches) {
  if (!m[1].startsWith(name)) {
    errors.push(`README.md: import "${m[1]}" should start with "${name}"`)
  }
}

// --- CHANGELOG has the version
const changelog = await read('CHANGELOG.md')
if (!new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm').test(changelog)) {
  errors.push(`CHANGELOG.md missing "## [${version}]" heading for the current version`)
}

// --- RELEASE.md tarball naming
const release = await read('RELEASE.md')
const tarballRefs = release.match(/[a-z0-9-]+-\d+\.\d+\.\d+\.tgz/g) ?? []
for (const ref of tarballRefs) {
  // Allow either the literal current version or a `<version>` placeholder shape.
  if (!ref.startsWith(`${name.replace(/^@/, '').replace(/\//g, '-')}-`)) {
    errors.push(
      `RELEASE.md: tarball ref "${ref}" doesn't match expected prefix "${tarballPrefix.replace(version, '<version>')}"`,
    )
  }
}

// --- Release artifact-producing job must stay isolated from third-party analysis tools.
const releaseWorkflow = await read('.github/workflows/release.yml')
const buildJobStart = releaseWorkflow.indexOf('\n  build:')
const publishJobStart = releaseWorkflow.indexOf('\n  publish:', buildJobStart)
const buildJobHeader = '\n  build:'
const buildJobTail =
  buildJobStart === -1 ? '' : releaseWorkflow.slice(buildJobStart + buildJobHeader.length)
const nextJobOffset = buildJobTail.search(/\n {2}[A-Za-z0-9_-]+:/)
const buildJob =
  buildJobStart === -1 || publishJobStart === -1
    ? ''
    : nextJobOffset === -1
      ? buildJobTail
      : buildJobTail.slice(0, nextJobOffset)
if (buildJob === '') {
  errors.push('release.yml should contain build and publish jobs in that order')
} else {
  const packStep = buildJob.indexOf('- name: Pack verified release artifact')
  const uploadStep = buildJob.indexOf('- name: Upload release artifact')
  if (packStep === -1 || uploadStep === -1 || packStep > uploadStep) {
    errors.push('release.yml build job must pack the verified artifact before uploading it')
  }
  if (/\battw\b/.test(buildJob)) {
    errors.push(
      'release.yml build job must not run attw before packing; ignored publish files such as dist/ could be changed after verification and then packed',
    )
  }
}

// --- src/version.ts must NOT hardcode the version; must import package.json
const versionTs = await read('src/version.ts')
if (
  !/import pkg from ['"]\.\.\/package\.json['"]\s*with\s*\{\s*type:\s*['"]json['"]\s*\}/.test(
    versionTs,
  )
) {
  errors.push(
    "src/version.ts must import package.json with `import pkg from '../package.json' with { type: 'json' }`",
  )
}
if (!/export const VERSION:\s*string\s*=\s*pkg\.version/.test(versionTs)) {
  errors.push('src/version.ts must export `VERSION` derived from `pkg.version`')
}

if (errors.length > 0) {
  console.error(`verify-package-metadata: ${errors.length} problem(s) found`)
  errors.forEach((e, i) => {
    console.error(`  ${i + 1}. ${e}`)
  })
  process.exit(1)
}

console.log(
  `verify-package-metadata: OK (name=${name}, version=${version}, tarball=${tarballPrefix}.tgz)`,
)
