import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const realWorkflow = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8')

// The verifier resolves the repository relative to its own location, so each
// case runs a copy of the script inside a throwaway tree with a mutated release.yml.
function runVerifier(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'b2-release-workflow-'))
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    copyFileSync(
      join(here, 'verify-release-workflow.mjs'),
      join(root, 'scripts/verify-release-workflow.mjs'),
    )
    copyFileSync(join(repo, 'package.json'), join(root, 'package.json'))
    copyFileSync(join(repo, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml'))
    writeFileSync(join(root, '.github/workflows/release.yml'), mutate(realWorkflow))
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/verify-release-workflow.mjs')],
      {
        encoding: 'utf8',
      },
    )
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function mutateOnce(text, from, to) {
  assert.ok(text.includes(from), `fixture anchor missing: ${from}`)
  return text.replace(from, to)
}

const checkoutStep = '      - uses: actions/checkout@v4\n'
const publishSteps = '    steps:\n      - uses: actions/setup-node@'
const buildHeader = '  build:\n'

test('the real release workflow passes the verifier', () => {
  const result = runVerifier((text) => text)
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /verify-release-workflow: OK/)
})

test('a checkout step in the job holding id-token: write is rejected', () => {
  const result = runVerifier((text) =>
    mutateOnce(text, publishSteps, `    steps:\n${checkoutStep}      - uses: actions/setup-node@`),
  )
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /publish job must not checkout repository code with id-token: write/)
})

// Known verifier gap (owner decision): hasOidcWritePermission only
// recognises a block-style `permissions:` at job level (4-space indent). These
// forms grant id-token: write to jobs that check out and install, and pass
// silently. They run as `todo` so the suite stays green until the owner decides.
const workflowLevelCases = [
  [
    'workflow-level block permissions',
    (text) =>
      mutateOnce(
        text,
        'permissions:\n  contents: read # default read-only access; release publishing escalates below\n',
        'permissions:\n  contents: read\n  id-token: write\n',
      ),
  ],
  [
    'workflow-level write-all',
    (text) =>
      mutateOnce(
        text,
        'permissions:\n  contents: read # default read-only access; release publishing escalates below\n',
        'permissions: write-all\n',
      ),
  ],
  [
    'job-level flow-style permissions on the build job',
    (text) =>
      mutateOnce(
        text,
        buildHeader,
        `${buildHeader}    permissions: { contents: read, id-token: write }\n`,
      ),
  ],
  [
    'job-level write-all on the build job',
    (text) => mutateOnce(text, buildHeader, `${buildHeader}    permissions: write-all\n`),
  ],
]

for (const [name, mutate] of workflowLevelCases) {
  test(`id-token write via ${name} is rejected when the build job checks out and installs`, {
    todo: 'verify-release-workflow.mjs does not detect this permission form',
  }, () => {
    const result = runVerifier(mutate)
    assert.equal(result.status, 1, `verifier accepted ${name}: ${result.output}`)
    assert.match(result.output, /build job must not checkout repository code with id-token: write/)
  })
}
