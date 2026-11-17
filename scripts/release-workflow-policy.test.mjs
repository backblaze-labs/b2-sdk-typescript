import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

async function checkWorkflow(t, change) {
  const root = await mkdtemp(join(tmpdir(), 'b2-release-workflow-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'scripts/verify-release-workflow.mjs']) {
    await copyFile(join(repo, file), join(root, file))
  }
  const workflow = await readFile(join(repo, '.github/workflows/release.yml'), 'utf8')
  const changed = change ? change(workflow) : workflow
  if (change) assert.notEqual(changed, workflow, 'workflow mutation must change the fixture')
  await writeFile(join(root, '.github/workflows/release.yml'), changed)
  return spawnSync(process.execPath, [join(root, 'scripts/verify-release-workflow.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('release workflow with all required policy and publication boundaries passes', async (t) => {
  const result = await checkWorkflow(t)
  assert.equal(result.status, 0, result.stderr)
})

test('release workflow cannot build without the explicit security and tag-policy dependencies', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace('needs: [release-policy, security]', 'needs: []'),
  )
  assert.notEqual(result.status, 0, 'build must depend on the explicit release gates')
  assert.match(result.stderr, /security|release-policy/i)
})

test('release workflow must execute its security triage command', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace('node scripts/release-security-check.mjs', 'node -e "process.exit(0)"'),
  )
  assert.notEqual(result.status, 0, 'a no-op must not satisfy the release security gate')
  assert.match(result.stderr, /security/i)
})

test('release artifact checkout must use the exact tag-policy commit', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replaceAll(`ref: \${{ needs.release-policy.outputs.commit }}`, `ref: \${{ env.REF }}`),
  )
  assert.notEqual(result.status, 0, 'a moving tag ref must not replace the inspected commit')
  assert.match(result.stderr, /commit/i)
})

test('release security errors cannot be marked continue-on-error', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace('  security:\n', '  security:\n    continue-on-error: true\n'),
  )
  assert.notEqual(result.status, 0, 'security triage must be a required gate')
  assert.match(result.stderr, /security/i)
})

test('release security triage cannot be skipped by a step condition', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace(
      'name: Check release security triage',
      'name: Check release security triage\n        if: false',
    ),
  )
  assert.notEqual(result.status, 0, 'security triage must actually execute')
  assert.match(result.stderr, /security/i)
})

test('release milestone readiness command cannot be removed', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace('node scripts/verify-release-milestone.mjs', 'node -e "process.exit(0)"'),
  )
  assert.notEqual(result.status, 0, 'release milestone must be checked')
  assert.match(result.stderr, /milestone/i)
})

test('security triage requires its configured security-read credential', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace(
      /GH_TOKEN: \$\{\{ secrets\.RELEASE_SECURITY_TOKEN[^\n]+/,
      `GH_TOKEN: \${{ github.token }}`,
    ),
  )
  assert.notEqual(
    result.status,
    0,
    'the publication gate must not silently fall back to an unqualified token',
  )
  assert.match(result.stderr, /security/i)
})

test('release actions must remain pinned to full commit SHAs', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@main'),
  )
  assert.notEqual(result.status, 0, 'floating action references are not permitted')
  assert.match(result.stderr, /pin|SHA/i)
})

for (const job of ['release-policy', 'security']) {
  test(`${job} must check out trusted policy from the default branch`, async (t) => {
    const result = await checkWorkflow(t, (workflow) =>
      workflow.replace(new RegExp(`^  ${job}:\\n[\\s\\S]*?(?=^  [a-z-]+:)`, 'm'), (section) =>
        section.replace(
          `ref: \${{ github.event.repository.default_branch }}`,
          `ref: \${{ env.REF }}`,
        ),
      ),
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /trusted|default.branch/i)
  })
}

test('release policy must fetch the tag history', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace('fetch-depth: 0', 'fetch-depth: 1'),
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fetch-depth/i)
})

test('tag enforcement must read the repository opt-in variable', async (t) => {
  const result = await checkWorkflow(t, (workflow) =>
    workflow.replace(
      `ENFORCE_SIGNED_TAGS: \${{ vars.ENFORCE_SIGNED_TAGS }}`,
      'ENFORCE_SIGNED_TAGS: false',
    ),
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ENFORCE_SIGNED_TAGS/i)
})
