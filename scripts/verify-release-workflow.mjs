#!/usr/bin/env node
// Verify release workflow trust-boundary invariants. Keep this dependency-free
// so the artifact-producing release job does not install another verifier-only
// parser before packing the npm tarball.

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const attwVersion = '0.18.3'

const forbiddenDirectDependencies = ['@arethetypeswrong/cli', '@arethetypeswrong/core']
const forbiddenLockPackages = [
  '@andrewbranch/untar.js@',
  '@arethetypeswrong/cli@',
  '@arethetypeswrong/core@',
  '@braidai/lang@',
  '@loaderkit/resolve@',
  '@sindresorhus/is@',
  'ansi-escapes@7.3.0',
  'ansi-regex@5.0.1',
  'ansi-styles@4.3.0',
  'any-promise@',
  'chalk@4.1.2',
  'char-regex@',
  'cjs-module-lexer@1.4.3',
  'cli-highlight@',
  'cli-table3@',
  'cliui@7.0.4',
  'color-convert@2.0.1',
  'color-name@1.1.4',
  'commander@10.0.1',
  'emoji-regex@8.0.0',
  'emojilib@',
  'environment@',
  'fflate@0.8.3',
  'get-caller-file@',
  'highlight.js@',
  'marked-terminal@',
  'marked@9.1.6',
  'typescript@5.6.1-rc',
  'validate-npm-package-name@',
  'wrap-ansi@7.0.0',
  'y18n@5.0.8',
  'yargs-parser@20.2.9',
  'yargs@16.2.2',
]

async function read(rel) {
  return await fs.readFile(join(repo, rel), 'utf8')
}

function extractJob(workflow, jobName) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${jobName}:`)
  if (start === -1) return ''

  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function includesInOrder(haystack, first, second) {
  const firstIndex = haystack.indexOf(first)
  const secondIndex = haystack.indexOf(second)
  return firstIndex !== -1 && secondIndex !== -1 && firstIndex < secondIndex
}

function hasLockPackage(lockfile, packageKey) {
  return lockfile.includes(`  ${packageKey}`) || lockfile.includes(`  '${packageKey}`)
}

/** @type {string[]} */
const errors = []

const pkg = JSON.parse(await read('package.json'))
for (const section of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  const deps = pkg[section]
  if (!deps || typeof deps !== 'object') continue

  for (const dependencyName of forbiddenDirectDependencies) {
    if (Object.hasOwn(deps, dependencyName)) {
      errors.push(
        `package.json ${section} must not include ${dependencyName}; release build installs project dependencies before packing.`,
      )
    }
  }
}

const lockfile = await read('pnpm-lock.yaml')
for (const packageKey of forbiddenLockPackages) {
  if (hasLockPackage(lockfile, packageKey)) {
    errors.push(
      `pnpm-lock.yaml must not include ${packageKey}; attw runs only through the isolated pinned npx analysis job.`,
    )
  }
}

const workflow = (await read('.github/workflows/release.yml')).replace(/\r\n?/g, '\n')
const buildJob = extractJob(workflow, 'build')
const packageTypeJob = extractJob(workflow, 'package-type-analysis')
const publishJob = extractJob(workflow, 'publish')
const githubReleaseJob = extractJob(workflow, 'github-release')

if (buildJob === '') errors.push('release.yml must define a build job.')
if (packageTypeJob === '') errors.push('release.yml must define a package-type-analysis job.')
if (publishJob === '') errors.push('release.yml must define a publish job.')
if (githubReleaseJob === '') errors.push('release.yml must define a github-release job.')

if (buildJob !== '') {
  if (/\battw\b|@arethetypeswrong\/cli|npx\s/.test(buildJob)) {
    errors.push(
      'release.yml build job must not run or install attw before packing the verified artifact.',
    )
  }
  if (
    !includesInOrder(
      buildJob,
      '- run: pnpm run verify:release',
      '- name: Pack verified release artifact',
    )
  ) {
    errors.push('release.yml build job must run verify:release before packing the artifact.')
  }
  if (
    !includesInOrder(
      buildJob,
      '- name: Pack verified release artifact',
      '- name: Upload release artifact',
    )
  ) {
    errors.push('release.yml build job must pack the verified artifact before uploading it.')
  }
}

if (packageTypeJob !== '') {
  const pinnedAttwCommand = `npx --yes -p @arethetypeswrong/cli@${attwVersion} attw --pack . --profile node16`
  if (!packageTypeJob.includes(pinnedAttwCommand)) {
    errors.push(
      `release.yml package-type-analysis job must run attw through pinned ephemeral command: ${pinnedAttwCommand}`,
    )
  }
}

if (publishJob !== '') {
  if (!publishJob.includes('needs: build')) {
    errors.push('release.yml publish job must consume the build artifact through needs: build.')
  }
  if (/pnpm\s+(install|build|test|lint)|npm\s+install/.test(publishJob)) {
    errors.push('release.yml publish job must not install dependencies, build, test, or lint.')
  }
  for (const requiredSnippet of [
    'LOCAL_INTEGRITY=',
    'PUBLISHED_INTEGRITY=',
    'PUBLISHED_SHASUM=',
    'EXPECTED=',
    'OBSERVED=',
    'ALLOW_REGISTRY_ARTIFACT_MISMATCH',
    'already published with different bytes',
  ]) {
    if (!publishJob.includes(requiredSnippet)) {
      errors.push(
        `release.yml publish job must compare existing npm artifact integrity before skipping publish; missing ${requiredSnippet}.`,
      )
    }
  }
}

if (githubReleaseJob !== '') {
  const ghReleaseLines = githubReleaseJob
    .split(/\r?\n/)
    .filter((line) => /\bgh release (view|edit|create)\b/.test(line))
  if (ghReleaseLines.length === 0) {
    errors.push('release.yml github-release job must invoke gh release.')
  }

  for (const line of ghReleaseLines) {
    if (!/--repo\s+["']?\$\{?GITHUB_REPOSITORY\}?["']?/.test(line)) {
      errors.push(
        `release.yml github-release command must pass --repo "$GITHUB_REPOSITORY": ${line.trim()}`,
      )
    }
  }
}

if (errors.length > 0) {
  console.error(`verify-release-workflow: ${errors.length} problem(s) found`)
  errors.forEach((error, index) => {
    console.error(`  ${index + 1}. ${error}`)
  })
  process.exit(1)
}

console.log('verify-release-workflow: OK')
