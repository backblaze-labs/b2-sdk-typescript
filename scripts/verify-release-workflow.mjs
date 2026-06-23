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

const dynamicPackageExecution =
  /\b(?:npx|pnpm\s+(?:dlx|exec)|npm\s+exec|yarn\s+(?:dlx|exec)|bunx|bun\s+x)\b/
const dependencyInstall = /\b(?:pnpm|npm|yarn|bun)\s+(?:install|i|ci)\b/
const packageScriptRun = /\b(?:pnpm|npm|yarn|bun)\s+run\b/
const checkedOutRepositoryScript = /\b(?:node|bun)\s+(?:\.\/)?scripts\//

async function read(rel) {
  return await fs.readFile(join(repo, rel), 'utf8')
}

function extractJobs(workflow) {
  const jobsSectionMatch = /^jobs:\s*\n/m.exec(workflow)
  if (jobsSectionMatch === null) return { hasJobsSection: false, jobs: [] }

  const jobLines = workflow
    .slice(jobsSectionMatch.index + jobsSectionMatch[0].length)
    .split('\n')
  const starts = []
  for (const [index, line] of jobLines.entries()) {
    const match = /^ {2}([A-Za-z0-9_-]+):$/.exec(line)
    if (match) starts.push({ index, name: match[1] })
  }

  return {
    hasJobsSection: true,
    jobs: starts.map((start, index) => {
      const end = starts[index + 1]?.index ?? jobLines.length
      return {
        body: jobLines.slice(start.index, end).join('\n'),
        name: start.name,
      }
    }),
  }
}

function includesInOrder(haystack, first, second) {
  const firstIndex = haystack.indexOf(first)
  const secondIndex = haystack.indexOf(second)
  return firstIndex !== -1 && secondIndex !== -1 && firstIndex < secondIndex
}

function hasLockPackage(lockfile, packageKey) {
  return lockfile.includes(`  ${packageKey}`) || lockfile.includes(`  '${packageKey}`)
}

function executableLines(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function rejectOidcJobHazards(jobName, body, errors) {
  if (/actions\/checkout@/.test(body)) {
    errors.push(`release.yml ${jobName} job must not checkout repository code with id-token: write.`)
  }
  if (dependencyInstall.test(body)) {
    errors.push(`release.yml ${jobName} job must not install dependencies with id-token: write.`)
  }
  if (checkedOutRepositoryScript.test(body)) {
    errors.push(
      `release.yml ${jobName} job must not execute checked-out repository scripts with id-token: write.`,
    )
  }
  if (dynamicPackageExecution.test(body)) {
    errors.push(
      `release.yml ${jobName} job must not run dynamic package execution with id-token: write.`,
    )
  }
  if (packageScriptRun.test(body)) {
    errors.push(`release.yml ${jobName} job must not run package scripts with id-token: write.`)
  }

  const publishLines = executableLines(body).filter((line) => /\bnpm\s+publish\b/.test(line))
  if (publishLines.length === 0) {
    errors.push(`release.yml ${jobName} job must publish the prebuilt tarball.`)
    return
  }

  for (const line of publishLines) {
    if (
      !line.includes('npm publish "$TARBALL"') &&
      !line.includes("npm publish '$TARBALL'") &&
      !line.includes('npm publish $TARBALL')
    ) {
      errors.push(`release.yml ${jobName} job must publish the downloaded tarball: ${line}`)
    }
  }

  if (!/find\s+\.release\b[\s\S]*-name\s+['"]\*\.tgz['"]/.test(body)) {
    errors.push(`release.yml ${jobName} job must resolve a .release/*.tgz artifact.`)
  }
}

function rejectUnsealedArtifactHazards(jobName, body, errors) {
  const artifactSealIndex = body.indexOf('actions/upload-artifact@')
  if (artifactSealIndex === -1) return

  const beforeSeal = body.slice(0, artifactSealIndex)
  if (dynamicPackageExecution.test(beforeSeal)) {
    errors.push(
      `release.yml ${jobName} job must not run dynamic package execution before uploading an artifact.`,
    )
  }
}

function rejectInstallScripts(jobName, body, errors) {
  for (const line of executableLines(body)) {
    if (dependencyInstall.test(line) && !line.includes('--ignore-scripts')) {
      errors.push(`release.yml ${jobName} dependency install must use --ignore-scripts.`)
    }
  }
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
const { hasJobsSection, jobs } = extractJobs(workflow)
if (!hasJobsSection) errors.push('release workflow does not define a jobs section.')

const buildJob = jobs.find((job) => job.name === 'build')?.body ?? ''
const packageTypeJob = jobs.find((job) => job.name === 'package-type-analysis')?.body ?? ''
const publishJob = jobs.find((job) => job.name === 'publish')?.body ?? ''
const githubReleaseJob = jobs.find((job) => job.name === 'github-release')?.body ?? ''

if (buildJob === '') errors.push('release.yml must define a build job.')
if (packageTypeJob === '') errors.push('release.yml must define a package-type-analysis job.')
if (publishJob === '') errors.push('release.yml must define a publish job.')
if (githubReleaseJob === '') errors.push('release.yml must define a github-release job.')

for (const { body, name } of jobs) {
  const hasOidcWrite = /^\s{4}permissions:\n(?:^\s{6}.+\n)*?^\s{6}id-token:\s*write\s*$/m.test(body)
  if (hasOidcWrite) rejectOidcJobHazards(name, body, errors)
  rejectUnsealedArtifactHazards(name, body, errors)
  rejectInstallScripts(name, body, errors)
}

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
