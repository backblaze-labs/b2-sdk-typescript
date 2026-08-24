import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const knownGhsa = 'GHSA-mh99-v99m-4gvg'
const here = dirname(fileURLToPath(import.meta.url))
const auditScript = join(here, 'audit-dependencies.mjs')

async function writeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'b2-audit-deps-'))
  const target = join(root, 'target')
  const bin = join(root, 'bin')
  const trustedAllowlist = join(root, 'trusted-allowlist.txt')
  const log = join(root, 'pnpm.log')

  await mkdir(join(target, '.github'), { recursive: true })
  await mkdir(bin)
  await writeFile(
    join(target, 'package.json'),
    JSON.stringify(
      {
        dependencies: { 'brace-expansion': '5.0.7' },
        scripts: { 'audit:deps': 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(target, '.github/audit-allowlist.txt'),
    `${knownGhsa} expires=2999-01-01 approver=@attacker reason="target-controlled"\n`,
  )
  if (Object.hasOwn(options, 'trustedAllowlist')) {
    await writeFile(trustedAllowlist, options.trustedAllowlist)
  }

  await writeFile(join(bin, 'pnpm.js'), fakePnpmScript)
  await writeFile(join(bin, 'pnpm'), fakePnpmShScript)
  await writeFile(join(bin, 'pnpm.cmd'), fakePnpmCmdScript)
  if (process.platform !== 'win32') {
    await chmod(join(bin, 'pnpm'), 0o755)
  }

  return {
    bin,
    log,
    target,
    trustedAllowlist,
  }
}

function runAudit(fixture, options = {}) {
  const { FORCE_COLOR: _forceColor, ...baseEnv } = process.env
  return spawnSync(
    process.execPath,
    [auditScript, '--allowlist', options.allowlistPath ?? fixture.trustedAllowlist, fixture.target],
    {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        FAKE_PNPM_LOG: fixture.log,
        PATH: options.path ?? `${fixture.bin}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  )
}

async function readPnpmCalls(log) {
  try {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

test('fails when a known vulnerable dependency is not allowlisted', async () => {
  const fixture = await writeFixture({ trustedAllowlist: '' })

  const result = runAudit(fixture)

  assert.equal(result.status, 1)
  const [call] = await readPnpmCalls(fixture.log)
  assert.equal(await realpath(call.cwd), await realpath(fixture.target))
  assert.deepEqual(call.args, ['audit', '--audit-level=moderate', '--ignore-registry-errors'])
})

test('suppresses an advisory only when trusted policy allowlists it', async () => {
  const fixture = await writeFixture({
    trustedAllowlist: `${knownGhsa} expires=2999-01-01 approver=@security reason="fixture #47 risk accepted"\n`,
  })

  const result = runAudit(fixture)

  assert.equal(result.status, 0, result.stderr)
  const [call] = await readPnpmCalls(fixture.log)
  assert.ok(call.args.includes(`--ignore=${knownGhsa}`))
})

test('ignores target-controlled audit scripts and allowlist policy', async () => {
  const fixture = await writeFixture({ trustedAllowlist: '' })

  const result = runAudit(fixture)

  assert.equal(result.status, 1)
  const [call] = await readPnpmCalls(fixture.log)
  assert.equal(await realpath(call.cwd), await realpath(fixture.target))
  assert.ok(!call.args.includes(`--ignore=${knownGhsa}`))
})

test('rejects unjustified allowlist entries before running audit', async () => {
  const fixture = await writeFixture({ trustedAllowlist: `${knownGhsa}\n` })

  const result = runAudit(fixture)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /expected GHSA ID/)
  assert.deepEqual(await readPnpmCalls(fixture.log), [])
})

test('rejects expired allowlist entries before running audit', async () => {
  const fixture = await writeFixture({
    trustedAllowlist: `${knownGhsa} expires=2000-01-01 approver=@security reason="expired"\n`,
  })

  const result = runAudit(fixture)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /expired on 2000-01-01/)
  assert.deepEqual(await readPnpmCalls(fixture.log), [])
})

test('treats a missing allowlist file as an empty allowlist', async () => {
  const fixture = await writeFixture()

  const result = runAudit(fixture, {
    allowlistPath: join(dirname(fixture.trustedAllowlist), 'missing-allowlist.txt'),
  })

  assert.equal(result.status, 1)
  const [call] = await readPnpmCalls(fixture.log)
  assert.ok(!call.args.some((arg) => arg.startsWith('--ignore=')))
})

test('fails closed when pnpm cannot be spawned', async () => {
  const fixture = await writeFixture({ trustedAllowlist: '' })
  const emptyPath = await mkdtemp(join(tmpdir(), 'b2-audit-empty-path-'))

  const result = runAudit(fixture, { path: emptyPath })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /spawn(?:Sync)? pnpm ENOENT|not found|not recognized/)
})

const fakePnpmShScript = `#!/bin/sh
exec node "$0.js" "$@"
`

const fakePnpmCmdScript = `@echo off
node "%~dp0pnpm.js" %*
`

const fakePnpmScript = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
fs.appendFileSync(
  process.env.FAKE_PNPM_LOG,
  JSON.stringify({ args, cwd: process.cwd() }) + '\\n',
)

if (!args.includes('audit')) {
  console.error('expected audit command')
  process.exit(99)
}

if (!args.includes('--ignore-registry-errors')) {
  console.error('missing --ignore-registry-errors')
  process.exit(99)
}

const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
const hasKnownVulnerability = packageJson.dependencies?.['brace-expansion'] === '5.0.7'
const isIgnored = args.includes('--ignore=${knownGhsa}')

process.exit(hasKnownVulnerability && !isIgnored ? 1 : 0)
`
