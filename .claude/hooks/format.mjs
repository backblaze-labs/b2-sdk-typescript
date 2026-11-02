#!/usr/bin/env node
// PostToolUse hook: Biome-format a file right after Claude edits it, so formatting
// never reaches review. Best effort: always exits 0 and never blocks the edit.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const file = input.tool_input?.file_path
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const rel = file ? relative(root, resolve(root, file)) : ''
  if (rel && !rel.startsWith('..') && /\.(c|m)?(j|t)sx?$|\.jsonc?$/.test(rel)) {
    execFileSync('pnpm', ['exec', 'biome', 'format', '--write', '--no-errors-on-unmatched', rel], {
      cwd: root,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
  }
} catch {
  // Formatting is a convenience; `pnpm lint` in `pnpm verify` is the gate.
}
