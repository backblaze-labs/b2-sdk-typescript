import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const livePath = new URL('../.github/workflows/integration.yml', import.meta.url)
const simulatorPath = new URL('../.github/workflows/simulator-integration.yml', import.meta.url)
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url)

// Windows checkouts may have CRLF line endings.
const read = async (path) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')

function stepScript(text, name) {
  const step = text.match(
    new RegExp(`- name: ${name}\\n[\\s\\S]*?\\n {8}run: \\|\\n((?: {10}.*\\n|\\n)+)`),
  )
  assert.ok(step, `step "${name}" not found`)
  return step[1].replace(/^ {10}/gm, '')
}

// Runs a workflow step's bash script with a stub `pnpm` that only records that
// the tests would have started.
async function runStep(t, script, env) {
  const bin = await mkdtemp(join(tmpdir(), 'b2-integration-step-'))
  t.after(() => rm(bin, { recursive: true, force: true }))
  await writeFile(join(bin, 'pnpm'), '#!/bin/sh\necho "TESTS STARTED: $*"\n')
  await chmod(join(bin, 'pnpm'), 0o755)
  return spawnSync('bash', ['-e', '-c', script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
  })
}

function triggerBlock(text) {
  return text.match(/^on:\n([\s\S]*?)^(?:concurrency|permissions|env|jobs):/m)?.[1] ?? ''
}

test('real B2 runs weekly or manually, never for a pull request or push', async () => {
  const text = await read(livePath)
  const triggers = triggerBlock(text)
  assert.match(triggers, /schedule:/)
  assert.match(triggers, /workflow_dispatch:/)
  assert.doesNotMatch(triggers, /pull_request:/)
  assert.doesNotMatch(triggers, /push:/)
})

// The key-management secrets are optional (AGENTS.md, "Live integration
// credentials"), so the weekly run must not fail only because they are absent.
// Half a pair is a misconfiguration and fails; a full pair runs the tests with
// B2_KEY_MANAGEMENT_REQUIRE_CREDENTIALS=1, so broken credentials fail.
test('key lifecycle skips with a notice without its secrets and runs with them', async (t) => {
  const text = await read(livePath)
  const script = stepScript(text, 'Run application-key lifecycle tests against real B2')
  const id = 'B2_KEY_MANAGEMENT_APPLICATION_KEY_ID'
  const key = 'B2_KEY_MANAGEMENT_APPLICATION_KEY'

  const absent = await runStep(t, script, { [id]: '', [key]: '' })
  assert.equal(absent.status, 0, absent.stderr)
  assert.match(absent.stdout, /::notice::.*not configured.*skipping/i)
  assert.doesNotMatch(absent.stdout, /TESTS STARTED/)

  for (const env of [
    { [id]: 'id', [key]: '' },
    { [id]: '', [key]: 'secret' },
  ]) {
    const half = await runStep(t, script, env)
    assert.notEqual(half.status, 0)
    assert.match(half.stdout, /::error::/)
    assert.doesNotMatch(half.stdout, /TESTS STARTED/)
  }

  const present = await runStep(t, script, { [id]: 'id', [key]: 'secret' })
  assert.equal(present.status, 0, present.stderr)
  assert.match(present.stdout, /TESTS STARTED: .*tests\/integration\/keys\.test\.ts/)
  const job = text.slice(text.indexOf('\n  key-lifecycle:\n'))
  assert.match(job, /B2_KEY_MANAGEMENT_REQUIRE_CREDENTIALS: '1'/)
})

test('CI runs this policy test', async () => {
  assert.match(await read(ciPath), /^ {6}- run: pnpm run verify:integration-workflow$/m)
})

test('pull requests run the live-shaped storage suite against B2 Simulator', async () => {
  const text = await read(simulatorPath)
  assert.match(triggerBlock(text), /pull_request:/)
  // One source of truth for the simulator revision: the shared action reads
  // scripts/b2-simulator/pin.mjs, so this workflow must not hard-code a SHA.
  assert.match(text, /uses: \.\/\.github\/actions\/b2-simulator/)
  assert.match(text, /ssh-key: \$\{\{ secrets\.SIMULATOR_DEPLOY_KEY \}\}/)
  assert.doesNotMatch(text, /ref: [0-9a-f]{40}/)
  assert.doesNotMatch(text, /SIMULATOR_REVISION/)
  // AGENTS.md: every job in a pull-request workflow skips Dependabot PRs.
  const jobs = text.split(/^jobs:\n/m)[1] ?? ''
  const jobIfs = jobs.match(/^ {4}if: .*$/gm) ?? []
  const jobCount = (jobs.match(/^ {2}[a-z][\w-]*:\n/gm) ?? []).length
  assert.ok(jobCount > 0)
  assert.equal(jobIfs.length, jobCount, 'every job needs an if: with the Dependabot guard')
  for (const line of jobIfs)
    assert.match(line, /github\.event\.pull_request\.user\.login != 'dependabot\[bot\]'/)
  // The live suite reaches the simulator through the existing B2_REALM hook.
  assert.match(text, /B2_REALM/)
  assert.match(text, /NODE_EXTRA_CA_CERTS/)
  assert.match(text, /B2_INTEGRATION_REQUIRE_CREDENTIALS: "1"/)
  assert.match(text, /B2_KEY_MANAGEMENT_REQUIRE_CREDENTIALS: "1"/)
  for (const file of ['b2', 'live-contracts', 'object-lock', 'keys']) {
    assert.match(text, new RegExp(`tests/integration/${file}\\.test\\.ts`))
  }
  assert.match(text, /exit 1/)
})
