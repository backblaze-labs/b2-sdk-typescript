#!/usr/bin/env node
// Install the published SDK into a fresh project and verify the release-facing
// entry points resolve through both ESM import and CommonJS require.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const packageName = '@backblaze-labs/b2-sdk'
const args = process.argv.slice(2)
const keepTemp = args.includes('--keep-temp')
const packageSpec =
  args.find((arg) => arg !== '--keep-temp' && arg !== '--') ?? `${packageName}@latest`
const repoPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedVersion = repoPackage.version
const pnpm = process.env.PNPM ?? 'pnpm'

function fail(message) {
  console.error(`smoke-published-package: ${message}`)
  process.exitCode = 1
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    const cmd = [command, ...args].join(' ')
    fail(`${cmd} failed with exit ${result.status ?? 'unknown'}`)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exit(1)
  }

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

function walkFiles(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    const stats = statSync(file)
    if (stats.isDirectory()) {
      files.push(...walkFiles(file))
    } else {
      files.push(file)
    }
  }
  return files
}

function verifyInstalledFiles(project) {
  const packageDir = join(project, 'node_modules', '@backblaze-labs', 'b2-sdk')
  if (!existsSync(packageDir)) {
    fail(`${packageName} was not installed in node_modules`)
    return
  }

  const realPackageDir = realpathSync(packageDir)
  const requiredFiles = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'dist/partner/index.js',
    'dist/partner/index.cjs',
    'dist/partner/index.d.ts',
    'dist/partner/index.d.cts',
    'dist/backup/index.js',
    'dist/backup/index.cjs',
    'dist/backup/index.d.ts',
    'dist/backup/index.d.cts',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'package.json',
  ]

  for (const file of requiredFiles) {
    if (!existsSync(join(realPackageDir, file))) {
      fail(`installed package is missing ${file}`)
    }
  }

  const leakedSource = walkFiles(realPackageDir).filter((file) =>
    file.startsWith(join(realPackageDir, 'src') + sep),
  )
  if (leakedSource.length > 0) {
    fail(`installed package contains src/ files: ${leakedSource.length}`)
  }
}

function smokeSource(moduleKind) {
  const loader = moduleKind === 'esm' ? 'await import' : 'require'
  const rootLoad =
    moduleKind === 'esm'
      ? `const root = await import('${packageName}')`
      : `const root = require('${packageName}')`
  const partnerLoad =
    moduleKind === 'esm'
      ? `const partner = await import('${packageName}/partner')`
      : `const partner = require('${packageName}/partner')`
  const backupLoad =
    moduleKind === 'esm'
      ? `const backup = await import('${packageName}/backup')`
      : `const backup = require('${packageName}/backup')`

  return `
${rootLoad}
${partnerLoad}
${backupLoad}

const checks = [
  [root.VERSION === ${JSON.stringify(expectedVersion)}, 'VERSION should be ${expectedVersion}'],
  [typeof root.B2Client === 'function', 'B2Client export missing'],
  [typeof partner.PartnerClient === 'function', 'PartnerClient export missing'],
  [typeof partner.PartnerRawClient === 'function', 'PartnerRawClient export missing'],
  [
    typeof partner.InMemoryPartnerAccountInfo === 'function',
    'InMemoryPartnerAccountInfo export missing from partner',
  ],
  [partner.PartnerCapability?.All === 'all', 'PartnerCapability export drifted in partner'],
  [typeof backup.BackupClient === 'function', 'BackupClient export missing'],
  [typeof backup.BackupRawClient === 'function', 'BackupRawClient export missing'],
  [
    typeof backup.InMemoryPartnerAccountInfo === 'function',
    'InMemoryPartnerAccountInfo export missing from backup',
  ],
  [backup.PartnerCapability?.All === 'all', 'PartnerCapability export drifted in backup'],
  [typeof backup.computerId === 'function', 'computerId export missing'],
]

const failed = checks.filter(([ok]) => !ok)
if (failed.length > 0) {
  for (const [, message] of failed) console.error(message)
  process.exit(1)
}

console.log('${moduleKind} smoke OK via ${loader}, VERSION = ' + root.VERSION)
`
}

const project = mkdtempSync(join(tmpdir(), 'b2-sdk-published-smoke-'))
try {
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  )

  console.log(`Installing ${packageSpec} in ${project}`)
  run(project, pnpm, ['add', '--ignore-scripts', packageSpec])
  verifyInstalledFiles(project)
  if (process.exitCode) process.exit(1)
  run(project, 'node', ['--input-type=module', '--eval', smokeSource('esm')])
  run(project, 'node', ['--eval', smokeSource('cjs')])
  console.log(`smoke-published-package: ${packageSpec} passed`)
} finally {
  if (keepTemp) {
    console.log(`smoke-published-package: kept ${project}`)
  } else {
    rmSync(project, { force: true, recursive: true })
  }
}
