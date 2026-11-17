import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const history = '## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- Historical note.\n'

async function fixture(t, version = '1.2.4', fragments = true) {
  const root = await mkdtemp(join(tmpdir(), 'b2-changelog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, '.changes/unreleased'), { recursive: true })
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
  const hook = /node (scripts\/[^\s]+)/.exec(pkg.scripts.version)?.[1]
  assert.ok(hook)
  await copyFile(join(repo, hook), join(root, hook))
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'junction')
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version, repository: { url: 'https://example.com/sdk.git' } }),
  )
  await writeFile(
    join(root, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Pending note.\n\n${history}`,
  )
  await writeFile(join(root, '.changes/header.tpl.md'), '# Changelog\n')
  await writeFile(join(root, '.changes/v1.2.3.md'), history)
  await writeFile(
    join(root, '.changie.yaml'),
    `changesDir: .changes
unreleasedDir: unreleased
headerPath: header.tpl.md
changelogPath: CHANGELOG.md
versionExt: md
versionFormat: '## [{{.VersionNoPrefix}}] - {{.Time.Format "2006-01-02"}}'
kindFormat: '### {{.Kind}}'
changeFormat: '- {{.Body}}'
kinds:
  - label: Fixed
`,
  )
  if (fragments) {
    await writeFile(
      join(root, '.changes/unreleased/fix.yaml'),
      'kind: Fixed\nbody: Pending note.\ntime: 2026-01-02T00:00:00Z\n',
    )
  }
  return { root, hook }
}

test('version lifecycle consumes fragments using the manifest version and preserves history', async (t) => {
  const { root, hook } = await fixture(t)
  const manifest = await readFile(join(root, 'package.json'), 'utf8')
  const result = spawnSync(process.execPath, [join(root, hook)], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.deepEqual(
    await readdir(join(root, '.changes/unreleased')),
    [],
    'released fragments must be consumed',
  )
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /## \[1\.2\.4\].*\n[\s\S]*- Pending note\./)
  assert.ok(changelog.includes(history.trim()), 'released history must be retained')
  assert.ok(!changelog.includes('[Unreleased]'), 'the changelog must be generated from fragments')
  assert.equal(
    await readFile(join(root, 'package.json'), 'utf8'),
    manifest,
    'Changie must not bump package.json',
  )
})

test('prerelease version lifecycle retains pending fragments and the existing changelog', async (t) => {
  const { root, hook } = await fixture(t, '1.3.0-rc.0')
  const before = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  const result = spawnSync(process.execPath, [join(root, hook)], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), before)
  assert.deepEqual(await readdir(join(root, '.changes/unreleased')), ['fix.yaml'])
})

test('stable version lifecycle rejects a release without fragments', async (t) => {
  const { root, hook } = await fixture(t, '1.2.4', false)
  const result = spawnSync(process.execPath, [join(root, hook)], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /changelog-version: stable releases require Changie fragments/)
})

for (const [version, accepted] of [
  ['1.2.3', false],
  ['1.2.2', false],
  ['1.1.9', false],
  ['1.3.0', true],
  ['2.0.0', true],
]) {
  test(`stable lifecycle ${accepted ? 'accepts' : 'rejects'} ${version} after 1.2.3`, async (t) => {
    const { root, hook } = await fixture(t, version)
    const result = spawnSync(process.execPath, [join(root, hook)], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, accepted ? 0 : 1, result.stderr)
    if (!accepted) {
      assert.match(
        result.stderr,
        /changelog-version: npm must select a version newer than the released history/,
      )
    }
  })
}

// Check the real archives as well as the isolated version-lifecycle fixtures.
test('each archived version retains its heading reference link in the generated changelog', async () => {
  const changelog = await readFile(join(repo, 'CHANGELOG.md'), 'utf8')
  const headings = [...changelog.matchAll(/^## \[([0-9.]+)\]/gm)]
  assert.ok(headings.length > 0)
  for (const [, version] of headings) {
    const archived = await readFile(join(repo, `.changes/v${version}.md`), 'utf8')
    const definition = archived.split('\n').find((line) => line.startsWith(`[${version}]: `))
    assert.ok(definition, `missing heading link for ${version}`)
    assert.ok(changelog.includes(definition), `generated heading link missing for ${version}`)
  }
})

test('stable version lifecycle can follow a prerelease preview of the same version', async (t) => {
  const { root, hook } = await fixture(t)
  await writeFile(
    join(root, '.changes/v1.2.4-rc.0.md'),
    '## [1.2.4-rc.0] - 2026-01-02\n\n- Preview.\n',
  )
  const result = spawnSync(process.execPath, [join(root, hook)], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), /## \[1\.2\.4\]/)
})

test('pnpm owns the version bump and can prepare the changelog without creating a tag', async (t) => {
  const { root, hook } = await fixture(t, '1.2.3')
  const initialized = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'release-fixture',
      version: '1.2.3',
      scripts: { version: `node ${hook} && git add -A CHANGELOG.md .changes` },
    }),
  )
  await writeFile(join(root, '.gitignore'), 'node_modules/\n')
  for (const args of [
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['add', '--all'],
    ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'],
  ]) {
    const prepared = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(prepared.status, 0, prepared.stderr)
  }
  const result = spawnSync('pnpm', ['version', '1.2.4', '--no-git-tag-version'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    shell: process.platform === 'win32',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, '1.2.4')
  assert.match(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), /## \[1\.2\.4\]/)
  assert.deepEqual(await readdir(join(root, '.changes/unreleased')), [])
  const tags = spawnSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' })
  assert.equal(tags.status, 0, tags.stderr)
  assert.equal(tags.stdout, '', 'release preparation must not create a tag')
})

test('changelog check rejects malformed pending fragments without changing release files', async (t) => {
  const { root } = await fixture(t)
  const checker = join(root, 'scripts/verify-changelog.mjs')
  await copyFile(join(repo, 'scripts/verify-changelog.mjs'), checker)
  const changie = join(root, 'node_modules/changie/npm/changie.js')
  const merged = spawnSync(process.execPath, [changie, 'merge'], { cwd: root, encoding: 'utf8' })
  assert.equal(merged.status, 0, merged.stderr)
  const before = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  const manifest = await readFile(join(root, 'package.json'), 'utf8')
  await writeFile(join(root, '.changes/unreleased/fix.yaml'), 'kind: Fixed\nbody: [unclosed\n')
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'invalid pending YAML must fail before release preparation')
  assert.match(result.stderr, /fragment/i)
  assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), before)
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest)
})
