import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const livePath = new URL('../.github/workflows/integration.yml', import.meta.url)
const simulatorPath = new URL('../.github/workflows/simulator-integration.yml', import.meta.url)

function triggerBlock(text) {
  return text.match(/^on:\n([\s\S]*?)^(?:concurrency|permissions|env|jobs):/m)?.[1] ?? ''
}

test('real B2 runs weekly or manually, never for a pull request or push', async () => {
  const text = await readFile(livePath, 'utf8')
  const triggers = triggerBlock(text)
  assert.match(triggers, /schedule:/)
  assert.match(triggers, /workflow_dispatch:/)
  assert.doesNotMatch(triggers, /pull_request:/)
  assert.doesNotMatch(triggers, /push:/)
  assert.doesNotMatch(text, /skipping application-key lifecycle tests/)
  assert.match(
    text,
    /B2_KEY_MANAGEMENT_APPLICATION_KEY_ID \/ B2_KEY_MANAGEMENT_APPLICATION_KEY are required/,
  )
})

test('pull requests run the live-shaped storage suite against B2 Simulator', async () => {
  const text = await readFile(simulatorPath, 'utf8')
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
