#!/usr/bin/env node
// Mechanical consistency guard for the repo's markdown.
//
// Reconciles doc *claims* against ground truth (package.json, src/, the vitest
// coverage config) and against each other, so drift fails CI instead of waiting
// to be noticed. When this fails, fix the doc OR the source it disagrees with —
// the assertion message names both sides.
//
// Runs on the docs-only CI path (see .github/workflows/ci.yml). No network.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8')

// ---- collect markdown (tracked + untracked), excluding generated/vendored trees
function markdownFiles() {
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
  const tracked = git(['ls-files', '*.md'])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '*.md'])
  return [...tracked.split('\n'), ...untracked.split('\n')]
    .filter(Boolean)
    .filter((f) => !f.startsWith('api-docs/') && !f.startsWith('node_modules/'))
    .sort()
}
const MD = markdownFiles()
// CHANGELOG/MIGRATION record history and may legitimately cite past values.
const HISTORICAL = new Set(['CHANGELOG.md', 'MIGRATION.md'])
const CURRENT = MD.filter((f) => !HISTORICAL.has(f))

// ---- inline code spans + fenced blocks (so prose like "pnpm remains" is ignored)
function codeText(md) {
  const spans = []
  for (const m of md.matchAll(/```[\s\S]*?```/g)) spans.push(m[0])
  for (const m of md.matchAll(/`[^`\n]+`/g)) spans.push(m[0])
  return spans.join('\n')
}

// ---- ground truth
const pkg = JSON.parse(read('package.json'))
const EXPORT_COUNT = Object.keys(pkg.exports ?? {}).length
const ENDPOINT_COUNT = new Set(read('src/raw/index.ts').match(/\b(?:b2|bz)_[a-z_]+/g) ?? []).size
const NODE_MIN = (pkg.engines?.node ?? '')
  .match(/(\d+)\.(\d+)/)
  ?.slice(1, 3)
  .join('.')
const cov = read('vitest.coverage.config.ts')
const COVERAGE = Object.fromEntries(
  ['statements', 'lines', 'functions', 'branches'].map((k) => [
    k,
    Number(cov.match(new RegExp(`${k}:\\s*(\\d+)`))?.[1]),
  ]),
)

test('every relative markdown link resolves', () => {
  const broken = []
  for (const f of MD) {
    const dir = join(repoRoot, dirname(f))
    for (const m of read(f).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      let t = m[1].trim()
      if (/^(https?:|mailto:|#|@)/.test(t)) continue
      t = t.split('#')[0]
      if (!t) continue
      try {
        readFileSync(normalize(join(dir, t)))
      } catch {
        try {
          // directory link (e.g. exec-plans/) — statable via readdir
          execFileSync('test', ['-e', normalize(join(dir, t))])
        } catch {
          broken.push(`${f} -> ${m[1]}`)
        }
      }
    }
  }
  assert.deepEqual(broken, [], `broken relative links:\n${broken.join('\n')}`)
})

test('every pnpm <script> in docs exists in package.json', () => {
  const scripts = new Set(Object.keys(pkg.scripts ?? {}))
  const builtins = new Set([
    'run',
    'install',
    'exec',
    'add',
    'dlx',
    'why',
    'ls',
    'list',
    'audit',
    'store',
    'create',
    'import',
    'up',
    'remove',
    'link',
    'publish',
    'pack',
    'init',
    'outdated',
    'test',
    'build', // pnpm subcommands / lifecycle
  ])
  const bad = []
  for (const f of MD) {
    for (const m of codeText(read(f)).matchAll(/pnpm(?:\s+run)?\s+([a-z][a-z0-9:_-]*)/g)) {
      const name = m[1]
      if (scripts.has(name) || builtins.has(name)) continue
      bad.push(`${f}: pnpm ${name}`)
    }
  }
  assert.deepEqual(bad, [], `docs reference non-existent pnpm scripts:\n${bad.join('\n')}`)
})

test(`native-endpoint count in docs equals src/raw (${ENDPOINT_COUNT})`, () => {
  const wrong = []
  for (const f of CURRENT) {
    // lookbehind excludes a digit fused to a letter, e.g. the "2" in "B2 native endpoints"
    for (const m of read(f).matchAll(
      /(?<![A-Za-z0-9])(\d+)\s+(?:B2\s+)?native(?:\s+API)?\s+endpoints/g,
    )) {
      if (Number(m[1]) !== ENDPOINT_COUNT) wrong.push(`${f}: says ${m[1]}`)
    }
  }
  assert.deepEqual(wrong, [], `endpoint count is ${ENDPOINT_COUNT}:\n${wrong.join('\n')}`)
})

test(`export-entry count in docs equals package.json (${EXPORT_COUNT})`, () => {
  const wrong = []
  for (const f of CURRENT) {
    for (const m of read(f).matchAll(/(?<![A-Za-z0-9])(\d+)\s+export entries/g)) {
      if (Number(m[1]) !== EXPORT_COUNT) wrong.push(`${f}: says ${m[1]}`)
    }
  }
  assert.deepEqual(wrong, [], `export count is ${EXPORT_COUNT}:\n${wrong.join('\n')}`)
})

test('coverage numbers in docs match vitest.coverage.config.ts', () => {
  const wrong = []
  for (const f of CURRENT) {
    const md = read(f)
    for (const k of Object.keys(COVERAGE)) {
      for (const m of md.matchAll(new RegExp(`(\\d+)%\\s+${k}\\b`, 'g'))) {
        if (Number(m[1]) !== COVERAGE[k]) wrong.push(`${f}: ${m[1]}% ${k} (config ${COVERAGE[k]}%)`)
      }
    }
  }
  assert.deepEqual(wrong, [], `coverage drift:\n${wrong.join('\n')}`)
})

test(`min Node version (${NODE_MIN}) appears in canonical docs`, () => {
  assert.ok(NODE_MIN, 'could not derive min node from package.json engines')
  for (const f of ['AGENTS.md', 'README.md', 'CONTRIBUTING.md']) {
    assert.ok(
      read(f).includes(NODE_MIN),
      `${f} does not mention min Node ${NODE_MIN} (engines: ${pkg.engines?.node})`,
    )
  }
})

test('no stale adr/ path references in docs', () => {
  const bad = []
  for (const f of MD) {
    if (/\badr\//.test(read(f))) bad.push(f)
  }
  assert.deepEqual(
    bad,
    [],
    `ADRs live in docs/design-docs/ now; stale "adr/" refs in:\n${bad.join('\n')}`,
  )
})

test('CLAUDE.md and GEMINI.md stay thin pointers to AGENTS.md', () => {
  for (const f of ['CLAUDE.md', 'GEMINI.md']) {
    const md = read(f)
    assert.ok(md.includes('AGENTS.md'), `${f} must point to AGENTS.md`)
    assert.ok(/@AGENTS\.md/.test(md), `${f} must @-import AGENTS.md`)
    const lines = md.trim().split('\n').length
    assert.ok(lines <= 20, `${f} is ${lines} lines — keep it a pointer, put content in AGENTS.md`)
  }
})

test('ADR catalog (index.md) matches the ADR files', () => {
  const idx = read('docs/design-docs/index.md')
  const catalog = new Map()
  for (const m of idx.matchAll(
    /^\|\s*\[(\d+)\]\([^)]+\)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*\[#(\d+)\]/gm,
  )) {
    catalog.set(m[1], { title: m[2], status: m[3], date: m[4], issue: m[5] })
  }
  const files = execFileSync('git', ['ls-files', 'docs/design-docs/0*.md'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  const fileNums = new Set()
  for (const rel of files) {
    const md = read(rel)
    const h = md.match(/^#\s*ADR\s+(\d+):\s*(.+)$/m)
    assert.ok(h, `${rel} missing "# ADR NNNN: Title" heading`)
    const num = h[1]
    fileNums.add(num)
    const got = {
      title: h[2].trim(),
      status: md.match(/^Status:\s*(.+)$/m)?.[1].trim(),
      date: md.match(/^Date:\s*(.+)$/m)?.[1].trim(),
      issue: md.match(/^Issue:.*#(\d+)/m)?.[1],
    }
    const row = catalog.get(num)
    assert.ok(row, `ADR ${num} (${rel}) is not in the index.md catalog`)
    assert.equal(got.title, row.title, `ADR ${num} title drift (file vs catalog)`)
    assert.equal(got.status, row.status, `ADR ${num} status drift (file vs catalog)`)
    assert.equal(got.date, row.date, `ADR ${num} date drift (file vs catalog)`)
    assert.equal(got.issue, row.issue, `ADR ${num} issue drift (file vs catalog)`)
  }
  for (const num of catalog.keys()) {
    assert.ok(fileNums.has(num), `catalog lists ADR ${num} but no matching file exists`)
  }
})
