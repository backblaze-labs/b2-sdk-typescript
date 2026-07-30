import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const verifyScript = join(here, 'verify-package-metadata.mjs')

async function writeFixture(files) {
  const repo = await mkdtemp(join(tmpdir(), 'b2-verify-metadata-'))
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: '@example/pkg',
        version: '1.2.3',
        type: 'module',
        scripts: { test: 'node --test' },
        devDependencies: { typescript: '^6.0.3' },
        packageManager: 'pnpm@11.1.0',
      },
      null,
      2,
    ),
  )
  await writeFile(join(repo, 'README.md'), '# @example/pkg\n\nnpm install @example/pkg\n')
  await writeFile(join(repo, 'CHANGELOG.md'), '## [1.2.3]\n')
  await writeFile(join(repo, 'RELEASE.md'), '# Release\n')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(
    join(repo, 'src/version.ts'),
    "import pkg from '../package.json' with { type: 'json' }\nexport const VERSION: string = pkg.version\n",
  )

  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(repo, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, contents)
  }

  return repo
}

function runVerify(repo) {
  return spawnSync(process.execPath, [verifyScript], {
    encoding: 'utf8',
    env: { ...process.env, B2_VERIFY_METADATA_REPO: repo },
  })
}

test('verify-package-metadata accepts a version-only metadata artifact', async () => {
  const repo = await writeFixture({
    'dist/version.js':
      "import metadata from './chunks/version-metadata.js'\nexport const VERSION = metadata.version\n",
    'dist/chunks/version-metadata.js': "export default { version: '1.2.3' }\n",
  })

  const result = runVerify(repo)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /distArtifacts=1/)
})

test('verify-package-metadata documents a source-only run when dist is absent', async () => {
  const repo = await writeFixture({})

  const result = runVerify(repo)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /distArtifacts=not-built/)
})

test('verify-package-metadata rejects a poisoned metadata artifact', async () => {
  const repo = await writeFixture({
    'dist/version.js':
      "import metadata from './chunks/version-metadata.js'\nexport const VERSION = metadata.version\n",
    'dist/chunks/version-metadata.js':
      "const name = '@example/pkg'\nexport default { version: '1.2.3', ['scripts']: {}, name }\n",
  })

  const result = runVerify(repo)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must export only \["version"\]/)
})

test('verify-package-metadata rejects string-built metadata artifact keys', async () => {
  const repo = await writeFixture({
    'dist/version.js':
      "import metadata from './chunks/version-metadata.js'\nexport const VERSION = metadata.version\n",
    'dist/chunks/version-metadata.js':
      "const metadata = { version: '1.2.3' }\nmetadata['na' + 'me'] = '@example/pkg'\nexport default metadata\n",
  })

  const result = runVerify(repo)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must export only \["version"\]/)
})

test('verify-package-metadata fails closed when built dist has no metadata artifact', async () => {
  const repo = await writeFixture({
    'dist/version.js': "export const VERSION = '1.2.3'\n",
  })

  const result = runVerify(repo)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /no version-only metadata artifact was found/)
})

test('verify-package-metadata rejects a missing referenced metadata artifact', async () => {
  const repo = await writeFixture({
    'dist/version.js':
      "import metadata from './chunks/missing-version-metadata.js'\nexport const VERSION = metadata.version\n",
  })

  const result = runVerify(repo)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /is referenced by dist\/version\.\* but does not exist/)
})

test('verify-package-metadata scans non-metadata dist chunks for package manifest leaks', async () => {
  const repo = await writeFixture({
    'dist/version.js':
      "import metadata from './chunks/version-metadata.js'\nexport const VERSION = metadata.version\n",
    'dist/chunks/version-metadata.js': "export default { version: '1.2.3' }\n",
    'dist/index.js':
      "const leaked = { version: '1.2.3', scripts: { build: 'vite' } }\nexport { leaked }\n",
  })

  const result = runVerify(repo)

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /dist\/index\.js includes package manifest key "scripts"/)
})
