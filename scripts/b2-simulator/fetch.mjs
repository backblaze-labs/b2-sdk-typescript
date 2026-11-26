#!/usr/bin/env node
// Fetches the pinned b2-simulator commit (pin.mjs) into node_modules/.cache, once.
// With B2SIM_DIR set it only checks that directory and fetches nothing.
//
// Usage: pnpm run simulator:fetch
//
// Private repository: git uses whatever credentials it already has. CI does not
// run this script; it checks out the pinned commit itself and sets B2SIM_DIR.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pinnedCacheDir, resolveServeScript, SIMULATOR_PIN } from './pin.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function git(args, cwd, env) {
  return execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] })
    .toString()
    .trim()
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

if (process.env.B2SIM_DIR?.trim()) {
  console.log(resolveServeScript({ repoRoot, env: process.env }))
  process.exit(0)
}

const target = pinnedCacheDir(repoRoot)
if (existsSync(join(target, 'bin', 'simulator', 'serve.mjs'))) {
  const head = git(['rev-parse', 'HEAD'], target, process.env)
  if (head !== SIMULATOR_PIN.commit) {
    console.error(
      `${target} holds ${head}, not the pinned ${SIMULATOR_PIN.commit}; delete it and rerun`,
    )
    process.exit(1)
  }
  console.log(resolveServeScript({ repoRoot, env: {} }))
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })
const staging = mkdtempSync(`${target}.partial-`)
try {
  const env = gitEnv()
  git(['init', '--quiet'], staging, env)
  git(['remote', 'add', 'origin', SIMULATOR_PIN.repository], staging, env)
  git(['fetch', '--quiet', '--depth', '1', 'origin', SIMULATOR_PIN.commit], staging, env)
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], staging, env)
  const head = git(['rev-parse', 'HEAD'], staging, env)
  if (head !== SIMULATOR_PIN.commit) {
    throw new Error(`fetched ${head}, expected the pinned ${SIMULATOR_PIN.commit}`)
  }
  renameSync(staging, target)
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  console.error(
    `could not fetch ${SIMULATOR_PIN.repository} at ${SIMULATOR_PIN.commit}: ${error.message}`,
  )
  console.error(
    'The repository is private: use git credentials that can read it, or set B2SIM_DIR to a local checkout.',
  )
  process.exit(1)
}
console.log(resolveServeScript({ repoRoot, env: {} }))
