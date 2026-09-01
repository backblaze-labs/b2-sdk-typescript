import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const runner = process.env.npm_execpath
const command = runner ? process.execPath : 'pnpm'
const baseArgs = runner ? [runner] : []

function runPnpm(args) {
  return spawnSync(command, [...baseArgs, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: process.env,
    shell: runner ? false : process.platform === 'win32',
  })
}

function assertOk(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

test('release build wiring advertises the published product token for stable versions', () => {
  try {
    assertOk(runPnpm(['run', 'clean']))
    assertOk(runPnpm(['run', 'build:release']))

    const result = runPnpm(['run', 'verify:release-channel', '--', '--published'])

    assertOk(result)
    const expectedProductVersion = pkg.version.includes('-') ? 'dev' : pkg.version
    assert.match(result.stdout, new RegExp(`b2-sdk-typescript/${expectedProductVersion}`))
  } finally {
    runPnpm(['run', 'clean'])
  }
})
