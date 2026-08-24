#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const severities = new Set(['info', 'low', 'moderate', 'high', 'critical'])
const auditLevel = 'moderate'
const auditTimeoutMs = 5 * 60 * 1000
const defaultAllowlistPath = '.github/audit-allowlist.txt'
const allowlistEntry =
  /^(?<id>GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\s+expires=(?<expires>\d{4}-\d{2}-\d{2})\s+approver=(?<approver>@[A-Za-z0-9][A-Za-z0-9-]*)\s+reason="(?<reason>[^"]+)"$/i

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const config = parseArgs(process.argv.slice(2))
const targetRepo = resolve(process.cwd(), config.targetRepo)
const allowlistPath = resolve(repo, config.allowlistPath)

if (!severities.has(auditLevel)) {
  console.error(`auditLevel must be one of ${Array.from(severities).join(', ')}; got ${auditLevel}`)
  process.exit(2)
}

const allowlist = readAllowlist(allowlistPath)
const invalidEntries = allowlist.filter((entry) => entry.error)

if (invalidEntries.length > 0) {
  console.error(
    `Dependency audit allowlist contains invalid entries:\n${invalidEntries
      .map((entry) => `- ${entry.line}: ${entry.error}`)
      .join('\n')}`,
  )
  process.exit(2)
}

const args = ['audit', `--audit-level=${auditLevel}`, '--ignore-registry-errors']
for (const entry of allowlist) {
  args.push(`--ignore=${entry.id}`)
}

const result = spawnSync('pnpm', args, {
  cwd: targetRepo,
  shell: process.platform === 'win32',
  stdio: 'inherit',
  timeout: auditTimeoutMs,
})

if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`pnpm audit timed out after ${auditTimeoutMs}ms`)
  } else {
    console.error(result.error.message)
  }
  process.exit(1)
}

if (typeof result.status === 'number') {
  process.exit(result.status)
}

if (result.signal) {
  console.error(`pnpm audit exited due to signal ${result.signal}`)
}

process.exit(1)

function parseArgs(args) {
  const config = {
    allowlistPath: defaultAllowlistPath,
    targetRepo: repo,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--allowlist') {
      const value = args[index + 1]
      if (!value) {
        console.error('--allowlist requires a path')
        process.exit(2)
      }
      config.allowlistPath = value
      index += 1
      continue
    }

    if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`)
      process.exit(2)
    }

    if (config.targetRepo !== repo) {
      console.error(`Unexpected extra argument: ${arg}`)
      process.exit(2)
    }

    config.targetRepo = arg
  }

  return config
}

function readAllowlist(path) {
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((rawLine, index) => parseAllowlistLine(rawLine, index + 1))
      .filter(Boolean)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function parseAllowlistLine(rawLine, lineNumber) {
  const line = rawLine.trim()
  if (line === '' || line.startsWith('#')) return undefined

  const match = allowlistEntry.exec(line)
  if (!match?.groups) {
    return {
      error: 'expected GHSA ID, expires=YYYY-MM-DD, approver=@handle, and reason="justification"',
      line: lineNumber,
    }
  }

  const { approver, expires, id, reason } = match.groups
  if (!isCalendarDate(expires)) {
    return { error: `invalid expiry date ${expires}`, line: lineNumber }
  }
  if (expires < new Date().toISOString().slice(0, 10)) {
    return { error: `allowlist entry for ${id} expired on ${expires}`, line: lineNumber }
  }
  if (!approver || !reason.trim()) {
    return { error: `allowlist entry for ${id} needs approver and reason`, line: lineNumber }
  }

  return { id, line: lineNumber }
}

function isCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}
