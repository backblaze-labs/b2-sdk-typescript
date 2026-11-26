import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// Repository-owned execution choice, not a QK evidence or equivalence rule.
// Keep the aggregate's slow suite; do not execute its fast prefix a second time.
const contextFields = [
  'target_source_uri',
  'report_id',
  'working_directory',
  'source_locator',
  'testing_types',
  'testing_type',
  'scope',
  'asset_ids',
  'expectation_ids',
  'evidence_criteria',
  'subject_binding',
  'run_evidence_intents',
  'requires_disposable_checkout',
  'credential_requirements',
  'credential_prerequisites',
  'runtime_prerequisites',
  'prerequisite_steps',
  'prerequisite_unresolved_reason',
]

/**
 * Select QK options while retaining every check unless this repository's exact
 * fast/aggregate overlap and matching execution context can be established.
 *
 * @param {object[]} options - Native QK Action Options.
 * @param {Record<string, string>} scripts - Root package scripts.
 * @param {string} root - Assessed checkout root.
 * @returns {{selected_option_ids: string[], omitted: object[]}} Execution selection only.
 */
export function selectChecks(options, scripts, root) {
  if (!Array.isArray(options) || options.length === 0) throw new Error('No QK options to select')
  const ids = options.map((option) => option.option_id)
  if (
    ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error('Invalid or duplicate QK option identifiers')
  }
  const find = (name) =>
    options.filter(
      (option) =>
        option.action_kind === 'run_found_checks' &&
        isDeepStrictEqual(option.command, ['pnpm', 'run', name]) &&
        option.working_directory === resolve(root),
    )
  const fast = find('test')
  const aggregate = find('test:all')
  const omitted = []
  const unchangedScripts =
    scripts.test === 'vitest run' &&
    scripts['test:all'] === 'vitest run && vitest run --config vitest.slow.config.ts' &&
    ['pretest', 'posttest', 'pretest:all', 'posttest:all'].every(
      (name) => !Object.hasOwn(scripts, name),
    )
  if (unchangedScripts && fast.length === 1 && aggregate.length === 1) {
    const a = fast[0]
    const b = aggregate[0]
    const runnable = [a, b].every(
      (option) =>
        option.cost_tier === 'cheap' &&
        !option.blocked_reason &&
        !option.prerequisite_unresolved_reason &&
        !option.credential_requirements?.length &&
        !option.credential_prerequisites?.length &&
        !option.prerequisite_steps?.length,
    )
    if (runnable && contextFields.every((key) => isDeepStrictEqual(a[key], b[key]))) {
      omitted.push({ option_id: a.option_id, covered_by: b.option_id })
    }
  }
  return {
    selected_option_ids: ids.filter((id) => !omitted.some((entry) => entry.option_id === id)),
    omitted,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, root, output] = process.argv.slice(2)
  if (!planPath || !root || !output)
    throw new Error('Usage: select-qk-checks.mjs PLAN ROOT OUTPUT_PREFIX')
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  const { scripts } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const selection = selectChecks(plan.options, scripts, root)
  writeFileSync(`${output}.json`, `${JSON.stringify(selection, null, 2)}\n`)
  writeFileSync(
    `${output}.args`,
    `${selection.selected_option_ids.flatMap((id) => ['--option-id', id]).join('\n')}\n`,
  )
}
