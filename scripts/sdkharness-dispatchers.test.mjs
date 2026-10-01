import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', '.sdkharness', 'tests')

// A copy of the dispatchers with scenario fixtures standing in for the real checks, so the
// translation from a leaf's standing line and exit status to SDKHARNESS_RESULT can be tested
// without a simulator.
function fixtureTree(level, scenarios) {
  const root = mkdtempSync(join(tmpdir(), 'sdkharness-dispatcher-'))
  cpSync(join(source, 'lib'), join(root, 'lib'), { recursive: true })
  for (const name of ['run-conformance', 'run-resilience']) {
    cpSync(join(source, name), join(root, name))
    chmodSync(join(root, name), 0o755)
  }
  mkdirSync(join(root, level))
  for (const [scenario, { verdict, exit }] of Object.entries(scenarios)) {
    const file = join(root, level, `${scenario}.cjs`)
    const prefix = level.toUpperCase()
    writeFileSync(
      file,
      `#!/usr/bin/env node\nconsole.log('${prefix} b2-sdk-typescript ${scenario} @simulator: ${verdict}')\nprocess.exit(${exit})\n`,
    )
    chmodSync(file, 0o755)
  }
  return root
}

function dispatch(root, level, scenario) {
  const result = spawnSync(join(root, `run-${level}`), [], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SDKHARNESS_TEST_LEVEL: level,
      SDKHARNESS_SCENARIO: scenario,
      SDKHARNESS_SIMULATOR_URL: 'http://127.0.0.1:8123',
      SDKHARNESS_SIMULATOR_CONTROL_URL: 'http://127.0.0.1:8124',
    },
  })
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('SDKHARNESS_RESULT'))
  return { status: result.status, fields: line?.split('\t') ?? [], stdout: result.stdout }
}

const scenarios = {
  'amber.ok': { verdict: 'COULD-NOT-RUN (no-client-option -- fixture)', exit: 0 },
  'amber.crash': { verdict: 'COULD-NOT-RUN (no-client-option -- fixture)', exit: 3 },
  'pass.ok': { verdict: 'PASS', exit: 0 },
  'pass.crash': { verdict: 'PASS', exit: 3 },
  'fail.ok': { verdict: 'FAIL (step -- detail)', exit: 1 },
}

for (const level of ['conformance', 'resilience']) {
  test(`${level} dispatcher translates standing verdicts and exit statuses`, () => {
    const root = fixtureTree(level, scenarios)
    try {
      const expected = {
        'amber.ok': [0, 'SKIP', 'no-client-option -- fixture'],
        // A leaf that printed COULD-NOT-RUN and then exited nonzero is a failure, not amber.
        'amber.crash': [1, 'FAIL', 'contract: SKIP exited 3'],
        'pass.ok': [0, 'PASS', '-'],
        'pass.crash': [1, 'FAIL', 'contract: PASS exited 3'],
        'fail.ok': [1, 'FAIL', 'step -- detail'],
      }
      for (const [scenario, [status, outcome, reason]] of Object.entries(expected)) {
        const got = dispatch(root, level, scenario)
        assert.equal(got.fields.length, 5, `${scenario}: ${got.stdout}`)
        assert.deepEqual(
          [got.status, got.fields[3], got.fields[4]],
          [status, outcome, reason],
          scenario,
        )
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
