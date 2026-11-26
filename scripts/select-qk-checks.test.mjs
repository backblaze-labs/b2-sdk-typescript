import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { selectChecks } from './select-qk-checks.mjs'

const scripts = {
  test: 'vitest run',
  'test:all': 'vitest run && vitest run --config vitest.slow.config.ts',
}
const root = resolve('/repo')
const option = (name, changes = {}) => ({
  option_id: `action-option:${name}`,
  action_kind: 'run_found_checks',
  command: ['pnpm', 'run', name],
  working_directory: root,
  cost_tier: 'cheap',
  testing_types: ['unit_testing'],
  expectation_ids: ['unit-expectation'],
  run_evidence_intents: [],
  ...changes,
})

test('workflow compiles then selects explicit options with the tested pinned QK release', () => {
  const workflow = readFileSync('.github/workflows/quality-run-demo.yml', 'utf8')
  const compile = workflow.indexOf('--json artifacts/action-options.json')
  const select = workflow.indexOf('node scripts/select-qk-checks.mjs artifacts/action-options.json')
  // biome-ignore lint/suspicious/noTemplateCurlyInString: assert literal Bash array expansion.
  const execute = workflow.indexOf('--execute "${selected_args[@]}"')
  assert.ok(compile > 0 && select > compile && execute > select)
  assert.ok(workflow.includes('node --test scripts/select-qk-checks.test.mjs'))
  assert.ok(!workflow.includes('--execute --all'))
  // The listing and the execute call must see the same Strategy/Harvest context,
  // otherwise the selector compares options that differ from the executed ones.
  const strategyHarvest =
    '--strategy artifacts/testing-strategy.json --harvest artifacts/harvest.json'
  const listing = workflow.lastIndexOf(strategyHarvest, compile)
  const executing = workflow.lastIndexOf(strategyHarvest, execute)
  assert.ok(
    listing > 0 && compile - listing - strategyHarvest.length < 20,
    'listing uses Strategy/Harvest',
  )
  assert.ok(
    executing > select && execute - executing - strategyHarvest.length < 20,
    'execute uses Strategy/Harvest',
  )
  assert.equal(
    (workflow.match(/quality-keeper\.git@35be8583b1f2b54155d0428f537aee5c22d7963a/g) ?? []).length,
    2,
  )
  for (const artifact of [
    'action-options.json',
    'selected-options.json',
    'selected-options.args',
  ]) {
    assert.ok(workflow.includes(`\n            artifacts/${artifact}\n`), `upload ${artifact}`)
  }
})

test('retains the aggregate including slow tests and omits only its repeated fast command', () => {
  const options = [option('lint'), option('test'), option('test:all')]
  const selected = selectChecks(options, scripts, root)
  assert.deepEqual(selected.selected_option_ids, ['action-option:lint', 'action-option:test:all'])
  assert.deepEqual(selected.omitted, [
    { option_id: 'action-option:test', covered_by: 'action-option:test:all' },
  ])
})

test('keeps both checks when script bodies or lifecycle hooks change', () => {
  for (const changed of [
    { ...scripts, test: 'vitest run src/' },
    { ...scripts, 'test:all': 'vitest run --all' },
    { ...scripts, pretest: 'node prepare.mjs' },
    { ...scripts, posttest: 'node collect.mjs' },
    { ...scripts, 'pretest:all': 'node prepare.mjs' },
    { ...scripts, 'posttest:all': 'node collect.mjs' },
  ]) {
    assert.equal(
      selectChecks([option('test'), option('test:all')], changed, root).omitted.length,
      0,
    )
  }
})

test('keeps checks with different execution, gating or evidence context', () => {
  for (const changed of [
    { cost_tier: 'expensive' },
    { blocked_reason: 'unavailable' },
    { working_directory: resolve('/repo/other') },
    { credential_requirements: ['SERVICE_KEY'] },
    { prerequisite_unresolved_reason: 'invalid contract' },
    { prerequisite_steps: [{ command: ['node', 'prepare.mjs'] }] },
    { testing_types: ['system_testing'] },
    { expectation_ids: ['another-expectation'] },
    { run_evidence_intents: [{ evidence_id: 'distinct' }] },
    { command: ['npm', 'run', 'test:all'] },
  ]) {
    const selected = selectChecks([option('test'), option('test:all', changed)], scripts, root)
    assert.equal(selected.omitted.length, 0, JSON.stringify(changed))
  }
})

test('retains unknown, single and ambiguous duplicate options', () => {
  for (const options of [
    [option('test')],
    [option('test:all')],
    [option('unknown')],
    [option('test'), option('test:all'), option('test:all', { option_id: 'second' })],
  ]) {
    assert.deepEqual(
      selectChecks(options, scripts, root).selected_option_ids,
      options.map((x) => x.option_id),
    )
  }
})

test('rejects an empty selection or unsafe and duplicate identifiers', () => {
  for (const options of [
    [],
    [option('test', { option_id: '--all\n--execute' })],
    [option('test'), option('test')],
  ]) {
    assert.throws(() => selectChecks(options, scripts, root))
  }
})

test('CLI writes explicit arguments and an omission record without running commands', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qk-select-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const options = [
    option('test', { working_directory: dir }),
    option('test:all', { working_directory: dir }),
  ]
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }))
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ options }))
  const result = spawnSync(
    process.execPath,
    ['scripts/select-qk-checks.mjs', join(dir, 'plan.json'), dir, join(dir, 'selection')],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(join(dir, 'selection.args'), 'utf8'),
    '--option-id\naction-option:test:all\n',
  )
  assert.equal(JSON.parse(readFileSync(join(dir, 'selection.json'), 'utf8')).omitted.length, 1)
})
