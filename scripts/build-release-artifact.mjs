#!/usr/bin/env node
// Cross-platform wrapper for release builds. npm runs package scripts through
// cmd.exe on Windows, so POSIX inline environment assignment is not portable.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const env = {
  ...process.env,
  B2_SDK_RELEASE_CHANNEL: 'published',
}
const runner = process.env.npm_execpath
const command = runner ? process.execPath : 'pnpm'
const args = runner ? [runner, 'run', 'build'] : ['run', 'build']

const result = spawnSync(command, args, {
  cwd: repo,
  env,
  shell: runner ? false : process.platform === 'win32',
  stdio: 'inherit',
})

if (result.error) {
  console.error(`build-release-artifact: failed to start ${command}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
