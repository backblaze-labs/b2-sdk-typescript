#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const advisoryId = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const auditLevel = process.env.PNPM_AUDIT_LEVEL ?? 'moderate'
const allowlistPath = resolve(
  repo,
  process.env.PNPM_AUDIT_ALLOWLIST ?? '.github/audit-allowlist.txt',
)

if (!severities.has(auditLevel)) {
  console.error(
    `PNPM_AUDIT_LEVEL must be one of ${Array.from(severities).join(', ')}; got ${auditLevel}`,
  )
  process.exit(2)
}

const allowlist = readAllowlist(allowlistPath)
const invalidAdvisories = allowlist.filter((advisory) => !advisoryId.test(advisory))

if (invalidAdvisories.length > 0) {
  console.error(
    `Dependency audit allowlist contains invalid GitHub advisory IDs: ${invalidAdvisories.join(
      ', ',
    )}`,
  )
  process.exit(2)
}

const args = ['audit', `--audit-level=${auditLevel}`]
for (const advisory of allowlist) {
  args.push(`--ignore=${advisory}`)
}

const result = spawnSync('pnpm', args, {
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

if (typeof result.status === 'number') {
  process.exit(result.status)
}

if (result.signal) {
  console.error(`pnpm audit exited due to signal ${result.signal}`)
}

process.exit(1)

function readAllowlist(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}
