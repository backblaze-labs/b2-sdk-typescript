#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const classifier = join(repoRoot, '.github/scripts/detect-changed-paths.sh')

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
}

function git(cwd, ...args) {
  return run('git', args, cwd)
}

function write(path, contents) {
  writeFileSync(path, contents)
}

function initRepo({ readme = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b2-docs-filter-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'ci@example.com')
  git(dir, 'config', 'user.name', 'CI')

  mkdirSync(join(dir, 'src/auth'), { recursive: true })
  mkdirSync(join(dir, 'adr'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  write(join(dir, 'src/auth/index.ts'), 'export const auth = true\n')
  write(join(dir, 'src/client.ts'), 'export const client = true\n')
  write(join(dir, 'adr/001-architecture.md'), '# Architecture\n')
  write(join(dir, 'CONTRIBUTING.md'), '# Contributing\n')
  write(join(dir, 'docs/guide.md'), '# Guide\n')
  if (readme) {
    write(join(dir, 'README.md'), '# package\n')
  }

  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

function commit(cwd, message = 'change') {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function classify(cwd, base, head = 'HEAD') {
  const output = join(cwd, 'github-output.txt')
  execFileSync('bash', [classifier], {
    cwd,
    env: {
      ...process.env,
      EVENT_NAME: 'pull_request',
      BASE_SHA: base,
      HEAD_SHA: head,
      GITHUB_OUTPUT: output,
      CHANGED_FILES_PATH: join(cwd, 'changed-files.txt'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  )
}

test('classifies ordinary markdown docs as docs-only', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  write(join(dir, 'CONTRIBUTING.md'), '# Contributing\n\nMore docs.\n')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'false', docs: 'true' })
})

test('classifies adr markdown as docs-only', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  write(join(dir, 'adr/001-architecture.md'), '# Architecture\n\nUpdated decision.\n')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'false', docs: 'true' })
})

test('classifies nested docs paths as docs-only', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  mkdirSync(join(dir, 'docs/reference/buckets'), { recursive: true })
  write(join(dir, 'docs/reference/buckets/list.md'), '# List buckets\n')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'false', docs: 'true' })
})

test('classifies package metadata markdown as docs-only', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  write(join(dir, 'README.md'), '# package\n\nnpm install typo-package\n')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'false', docs: 'true' })
})

test('treats source-to-docs renames as code-changing', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  git(dir, 'mv', 'src/auth/index.ts', 'docs/auth-index.ts')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'true', docs: 'true' })
})

test('treats source-to-root-markdown renames as code-changing', (t) => {
  const { dir, base } = initRepo({ readme: false })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  git(dir, 'mv', 'src/client.ts', 'README.md')
  commit(dir)

  assert.deepEqual(classify(dir, base), { code: 'true', docs: 'true' })
})

test('falls back to code-changing on diff failures', (t) => {
  const { dir, base } = initRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.deepEqual(classify(dir, base, 'missing-head'), { code: 'true', docs: 'false' })
})
