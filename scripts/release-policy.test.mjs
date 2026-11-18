import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const emptyGithubGpg = `-----BEGIN PGP PUBLIC KEY BLOCK-----
Note: This user hasn't uploaded any GPG keys.


=twTO
-----END PGP PUBLIC KEY BLOCK-----`

test('production signing roster contains exactly the intended maintainers', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const roster = (await readFile(join(root, '.github/signing-maintainers'), 'utf8'))
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
    .sort()
  assert.deepEqual(roster, ['ffumero2003', 'goanpeca', 'sophiecarreras'])
})

function command(program, args, cwd, options = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 30_000, ...options })
  assert.equal(result.status, 0, `${program} ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

async function tagFixture(t, signed = false) {
  const root = await mkdtemp(join(tmpdir(), 'b2-tag-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  await mkdir(repo)
  command('git', ['init', '-q'], repo)
  command('git', ['config', 'user.name', 'Fixture Maintainer'], repo)
  command('git', ['config', 'user.email', 'fixture@example.invalid'], repo)
  command('git', ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], repo)
  const key = join(root, 'signing-key')
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], root)
  if (signed) {
    command(
      'git',
      [
        '-c',
        'gpg.format=ssh',
        '-c',
        `user.signingkey=${key}`,
        'tag',
        '-s',
        'v1.2.3',
        '-m',
        'fixture',
      ],
      repo,
    )
  } else {
    command('git', ['-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.2.3', '-m', 'fixture'], repo)
  }
  await mkdir(join(repo, '.github'))
  await writeFile(join(repo, '.github/signing-maintainers'), 'fixture-maintainer\n')
  const publicKey = await readFile(`${key}.pub`, 'utf8')
  const fetchKey = async (url) =>
    new Response(url.endsWith('.keys') ? publicKey : url.endsWith('ssh_signing_keys') ? '[]' : '')
  return { repo, key, publicKey, fetchKey, commit: command('git', ['rev-parse', 'HEAD'], repo) }
}

test('unsigned annotated release tag is rejected when enforcement is enabled', async (t) => {
  const fixture = await tagFixture(t)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  await assert.rejects(verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true }), /signature/i)
})

test('unsigned release tag warns without blocking by default', async (t) => {
  const fixture = await tagFixture(t)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3' })
  assert.equal(result.verified, false)
  assert.equal(result.commit, fixture.commit)
  assert.ok(result.warnings.some((warning) => /signature/i.test(warning)))
})

test('missing key enrollment warns without blocking the rollout', async (t) => {
  const fixture = await tagFixture(t, true)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const fetchKey = async (url) => new Response(url.endsWith('ssh_signing_keys') ? '[]' : '')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', fetchKey })
  assert.equal(result.verified, false)
  assert.ok(result.warnings.some((warning) => /No signing keys enrolled/.test(warning)))
})

test('registered maintainer SSH signature passes real git verify-tag', async (t) => {
  const fixture = await tagFixture(t, true)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'refs/tags/v1.2.3', enforce: true })
  assert.equal(result.verified, true)
  assert.equal(result.commit, fixture.commit)
})

test('every intended maintainer has all public key sources resolved', async (t) => {
  const fixture = await tagFixture(t, true)
  const roster = ['goanpeca', 'ffumero2003', 'sophiecarreras']
  await writeFile(join(fixture.repo, '.github/signing-maintainers'), roster.join('\n'))
  const seen = []
  const fetchKey = async (url) => {
    seen.push(url)
    return fixture.fetchKey(url)
  }
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey })
  assert.equal(result.verified, true)
  assert.deepEqual(
    seen.sort(),
    roster
      .flatMap((name) => [
        `https://github.com/${name}.gpg`,
        `https://github.com/${name}.keys`,
        `https://api.github.com/users/${name}/ssh_signing_keys`,
      ])
      .sort(),
  )
})

test('GitHub signing-only SSH keys are accepted alongside the public keys feed', async (t) => {
  const fixture = await tagFixture(t, true)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const fetchKey = async (url) =>
    new Response(
      url.endsWith('ssh_signing_keys') ? JSON.stringify([{ key: fixture.publicKey.trim() }]) : '',
    )
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey })
  assert.equal(result.verified, true)
})

test('SSH-only enrollment accepts GitHub empty GPG armor', {
  skip: spawnSync('gpg', ['--version']).status !== 0 ? 'gpg is not installed' : false,
}, async (t) => {
  const fixture = await tagFixture(t, true)
  const fetchKey = async (url) =>
    new Response(
      url.endsWith('.gpg') ? emptyGithubGpg : url.endsWith('.keys') ? fixture.publicKey : '[]',
    )
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey })
  assert.equal(result.verified, true)
})

test('GitHub empty GPG armor does not count as enrolled key material', {
  skip: spawnSync('gpg', ['--version']).status !== 0 ? 'gpg is not installed' : false,
}, async (t) => {
  const fixture = await tagFixture(t, true)
  const fetchKey = async (url) =>
    new Response(
      url.endsWith('.gpg') ? emptyGithubGpg : url.endsWith('ssh_signing_keys') ? '[]' : '',
    )
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', fetchKey })
  assert.ok(result.warnings.some((warning) => /No signing keys enrolled/.test(warning)))
})

test('malformed armored GPG feeds cannot satisfy enforcement through SSH', {
  skip: spawnSync('gpg', ['--version']).status !== 0 ? 'gpg is not installed' : false,
}, async (t) => {
  const fixture = await tagFixture(t, true)
  const fetchKey = async (url) =>
    new Response(
      url.endsWith('.gpg')
        ? '-----BEGIN PGP PUBLIC KEY BLOCK-----\ninvalid key data\n-----END PGP PUBLIC KEY BLOCK-----'
        : url.endsWith('.keys')
          ? fixture.publicKey
          : '[]',
    )
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey }),
    /GPG key data is malformed/,
  )
})

test('an unregistered signer cannot satisfy enforcement', async (t) => {
  const fixture = await tagFixture(t, true)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const otherKey = `${fixture.key}-approved`
  command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherKey], fixture.repo)
  const approved = await readFile(`${otherKey}.pub`, 'utf8')
  const fetchKey = async (url) =>
    new Response(url.endsWith('.keys') ? approved : url.endsWith('ssh_signing_keys') ? '[]' : '')
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey }),
    /enroll|key|signature/i,
  )
})

test('unreadable key sources cannot satisfy enforcement', async (t) => {
  const fixture = await tagFixture(t, true)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const fetchKey = async (url) =>
    url.endsWith('.gpg') ? new Response('', { status: 503 }) : fixture.fetchKey(url)
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey }),
    /Public signing keys could not be read/,
  )
})

test('tag verification stays bound to the object inspected before key lookup', async (t) => {
  const fixture = await tagFixture(t, true)
  command(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'next'],
    fixture.repo,
  )
  command('git', ['-c', 'tag.gpgsign=false', 'tag', '-a', 'v1.2.4', '-m', 'next'], fixture.repo)
  const replacement = command('git', ['rev-parse', 'refs/tags/v1.2.4'], fixture.repo)
  let moved = false
  const fetchKey = async (url) => {
    if (!moved) {
      moved = true
      command('git', ['update-ref', 'refs/tags/v1.2.3', replacement], fixture.repo)
    }
    return fixture.fetchKey(url)
  }
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey })
  assert.equal(result.verified, true)
  assert.equal(result.commit, fixture.commit)
})

test('a signed tag annotation cannot be reused under another release name', async (t) => {
  const fixture = await tagFixture(t, true)
  const object = command('git', ['rev-parse', 'refs/tags/v1.2.3'], fixture.repo)
  command('git', ['update-ref', 'refs/tags/v1.2.4', object], fixture.repo)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.4', enforce: true }),
    /signature|annotation/i,
  )
})

test('invalid tag refs are rejected even in warning mode', async (t) => {
  const fixture = await tagFixture(t)
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  await assert.rejects(verifyReleaseTag({ ...fixture, tag: 'refs/heads/main' }), /release tag/i)
})

function apiFixture(overrides = {}) {
  const paths = []
  const api = async (path) => {
    paths.push(path)
    if (path.includes('/code-scanning/alerts?state=open&per_page=100')) return overrides.code ?? []
    if (path.endsWith('/dependabot/alerts?state=open&per_page=100'))
      return overrides.dependencies ?? []
    if (path.endsWith('/secret-scanning/alerts?state=open&per_page=100'))
      return overrides.secrets ?? []
    if (path.includes('/security-advisories?state=')) {
      const state = new URLSearchParams(path.split('?')[1]).get('state')
      return (overrides.advisories ?? []).filter((advisory) => advisory.state === state)
    }
    if (path.endsWith('/milestones?state=all&per_page=100'))
      return overrides.milestones ?? [{ number: 7, title: 'v1.2.3' }]
    if (path.endsWith('/issues?milestone=7&state=open&per_page=100')) return overrides.items ?? []
    throw new Error(`unexpected request ${path}`)
  }
  return { api, paths }
}

test('security gate reads every triage source and allows an empty result', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const fixture = apiFixture()
  const result = await checkReleaseSecurity({
    repo: 'example/sdk',
    tag: 'v1.2.3',
    api: fixture.api,
  })
  assert.deepEqual(result.holds, [])
  assert.equal(fixture.paths.length, 5)
  assert.ok(fixture.paths.some((path) => path.includes('ref=refs%2Fheads%2Fmain')))
})

test('security gate explicitly requests unpublished advisory states', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const { api, paths } = apiFixture()
  await checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.3', api })
  assert.ok(paths.some((path) => path.includes('security-advisories?state=draft&')))
  assert.ok(paths.some((path) => path.includes('security-advisories?state=triage&')))
})

for (const [name, overrides] of [
  ['code scanning', { code: [{ number: 1 }] }],
  [
    'fixable dependency',
    {
      dependencies: [
        { security_vulnerability: { first_patched_version: { identifier: '1.2.4' } } },
      ],
    },
  ],
  ['secret scanning', { secrets: [{ secret: 'fixture-value-must-not-appear' }] }],
  [
    'draft advisory',
    {
      advisories: [
        {
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
          state: 'draft',
          summary: 'fixture-summary-must-not-appear',
        },
      ],
    },
  ],
  ['triage advisory', { advisories: [{ ghsa_id: 'GHSA-xxxx-yyyy-zzzz', state: 'triage' }] }],
]) {
  test(`security gate holds on ${name} without including private details`, async () => {
    const { checkReleaseSecurity } = await import('./release-security-check.mjs')
    const { api } = apiFixture(overrides)
    const result = await checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.3', api })
    assert.ok(result.holds.length > 0)
    assert.ok(
      result.holds.every((hold) => hold.startsWith('HOLD:')),
      JSON.stringify(result.holds),
    )
    assert.ok(!JSON.stringify(result).includes('must-not-appear'))
    assert.ok(!JSON.stringify(result).includes('GHSA-xxxx-yyyy-zzzz'))
  })
}

test('dependency alerts without a fix are reported as notes', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const { api } = apiFixture({
    dependencies: [{ security_vulnerability: { first_patched_version: null } }],
  })
  const result = await checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.3', api })
  assert.deepEqual(result.holds, [])
  assert.ok(result.notes.some((note) => /no patched version/i.test(note)))
})

test('unreadable security data is an UNVERIFIED hold', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const api = async () => {
    throw new Error('fixture-private-api-body')
  }
  const result = await checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.3', api })
  assert.equal(result.holds.length, 4)
  assert.ok(result.holds.every((hold) => /UNVERIFIED/.test(hold)))
  assert.ok(!JSON.stringify(result).includes('fixture-private-api-body'))
})

test('malformed security responses are holds rather than clear results', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const result = await checkReleaseSecurity({
    repo: 'example/sdk',
    tag: 'v1.2.3',
    api: async () => ({}),
  })
  assert.equal(result.holds.length, 4)
  assert.ok(result.holds.every((hold) => hold.startsWith('UNVERIFIED:')))
})

test('private fixed-advisory approval is scoped to the exact release and only draft state', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const { api } = apiFixture({ advisories: [{ ghsa_id: 'GHSA-xxxx-yyyy-zzzz', state: 'draft' }] })
  const approval = JSON.stringify({ tag: 'v1.2.3', advisories: ['GHSA-xxxx-yyyy-zzzz'] })
  const result = await checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.3', api, approval })
  assert.deepEqual(result.holds, [])
  await assert.rejects(
    checkReleaseSecurity({ repo: 'example/sdk', tag: 'v1.2.4', api, approval }),
    /approval/i,
  )
  const triage = apiFixture({ advisories: [{ ghsa_id: 'GHSA-xxxx-yyyy-zzzz', state: 'triage' }] })
  const blocked = await checkReleaseSecurity({
    repo: 'example/sdk',
    tag: 'v1.2.3',
    api: triage.api,
    approval,
  })
  assert.ok(blocked.holds.length > 0)
})

test('release milestone must exist and contain no open issues or pull requests', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  assert.equal(
    (await checkReleaseMilestone({ repo: 'example/sdk', tag: 'v1.2.3', api: apiFixture().api }))
      .number,
    7,
  )
  await assert.rejects(
    checkReleaseMilestone({
      repo: 'example/sdk',
      tag: 'v1.2.3',
      api: apiFixture({ milestones: [] }).api,
    }),
    /milestone/i,
  )
  for (const item of [{ number: 1 }, { number: 2, pull_request: {} }]) {
    await assert.rejects(
      checkReleaseMilestone({
        repo: 'example/sdk',
        tag: 'v1.2.3',
        api: apiFixture({ items: [item] }).api,
      }),
      /open/i,
    )
  }
})

test('milestone API access failures do not pass readiness', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  await assert.rejects(
    checkReleaseMilestone({
      repo: 'example/sdk',
      tag: 'v1.2.3',
      api: async () => {
        throw new Error('unavailable')
      },
    }),
    /UNVERIFIED/i,
  )
})

test('release milestone requires one exact title rather than a prefix or duplicates', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  for (const milestones of [
    [{ number: 7, title: 'v1.2.30' }],
    [{ number: 7, title: 'v1.2.3-rc.0' }],
    [
      { number: 7, title: 'v1.2.3' },
      { number: 8, title: 'v1.2.3' },
    ],
  ]) {
    await assert.rejects(
      checkReleaseMilestone({
        repo: 'example/sdk',
        tag: 'v1.2.3',
        api: apiFixture({ milestones }).api,
      }),
      /must exist exactly once/,
    )
  }
})

test('tag enforcement requires the literal true opt-in', async () => {
  const { enforceSignedTags } = await import('./verify-release-tag.mjs')
  for (const value of [undefined, '', 'false', '0', 'off', '1', 'on', 'TRUE', ' true ', 'treu']) {
    assert.equal(enforceSignedTags(value), false, `unexpected enforcement for ${String(value)}`)
  }
  assert.equal(enforceSignedTags('true'), true)
})

test('GitHub policy lists include every page and fail on missing API access', async () => {
  const { githubList } = await import('./release-policy-common.mjs')
  const run = (_program, args) => {
    assert.ok(args.includes('--paginate'))
    assert.ok(args.includes('--slurp'))
    return { status: 0, stdout: JSON.stringify([[{ number: 1 }], [{ number: 2 }]]) }
  }
  assert.deepEqual(await githubList('repos/example/sdk/milestones', run), [
    { number: 1 },
    { number: 2 },
  ])
  await assert.rejects(
    githubList('repos/example/sdk/milestones', () => ({
      status: 1,
      stderr: 'private API details',
    })),
    /unavailable/,
  )
})

test('registered maintainer GPG signature passes real git verify-tag', {
  skip: spawnSync('gpg', ['--version']).status !== 0 ? 'gpg is not installed' : false,
}, async (t) => {
  const fixture = await tagFixture(t)
  const home = await mkdtemp(join(tmpdir(), 'b2-gpg-fixture-'))
  t.after(async () => {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'])
    await rm(home, { recursive: true, force: true })
  })
  command(
    'gpg',
    [
      '--batch',
      '--homedir',
      home,
      '--passphrase',
      '',
      '--quick-generate-key',
      'Fixture Maintainer <fixture@example.invalid>',
      'ed25519',
      'sign',
      '0',
    ],
    fixture.repo,
  )
  const listing = command(
    'gpg',
    ['--batch', '--homedir', home, '--with-colons', '--list-secret-keys'],
    fixture.repo,
  )
  const fingerprint = listing
    .split('\n')
    .find((line) => line.startsWith('fpr:'))
    .split(':')[9]
  command('git', ['tag', '-d', 'v1.2.3'], fixture.repo)
  command(
    'git',
    [
      '-c',
      'gpg.format=openpgp',
      '-c',
      `user.signingkey=${fingerprint}`,
      'tag',
      '-s',
      'v1.2.3',
      '-m',
      'fixture',
    ],
    fixture.repo,
    { env: { ...process.env, GNUPGHOME: home } },
  )
  const key = command(
    'gpg',
    ['--batch', '--homedir', home, '--armor', '--export', fingerprint],
    fixture.repo,
  )
  const fetchKey = async (url) =>
    new Response(url.endsWith('.gpg') ? key : url.endsWith('ssh_signing_keys') ? '[]' : '')
  const { verifyReleaseTag } = await import('./verify-release-tag.mjs')
  const result = await verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey })
  assert.equal(result.verified, true)
})

for (const script of [
  'release-security-check.mjs',
  'verify-release-milestone.mjs',
  'verify-release-tag.mjs',
]) {
  test(`${script} executes through a symlinked checkout path`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b2-policy-entry-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
    const alias = join(root, 'checkout')
    await symlink(repo, alias, 'junction')
    const result = spawnSync(process.execPath, [join(alias, 'scripts', script), 'invalid-tag'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 1, 'the CLI must run and reject the invalid release tag')
    assert.match(result.stderr, /release tag|UNVERIFIED/i)
  })
}

async function tagCliFixture(t) {
  const fixture = await tagFixture(t)
  const source = join(dirname(fileURLToPath(import.meta.url)), '..')
  await mkdir(join(fixture.repo, 'scripts'))
  for (const file of ['verify-release-tag.mjs', 'release-policy-common.mjs']) {
    await copyFile(join(source, 'scripts', file), join(fixture.repo, 'scripts', file))
  }
  const preload = join(fixture.repo, 'fetch-fixture.mjs')
  await writeFile(
    preload,
    `globalThis.fetch = async (url) => new Response(url.endsWith('ssh_signing_keys') ? '[]' : '')\n`,
  )
  const output = join(fixture.repo, 'github-output')
  const env = {
    ...process.env,
    GITHUB_OUTPUT: output,
    GITHUB_ACTIONS: 'true',
    GITHUB_REF: 'refs/tags/v1.2.3',
    GITHUB_SHA: fixture.commit,
  }
  delete env.ENFORCE_SIGNED_TAGS
  const run = (extraEnv = {}) =>
    spawnSync(
      process.execPath,
      ['--import', preload, join(fixture.repo, 'scripts/verify-release-tag.mjs'), 'v1.2.3'],
      { cwd: fixture.repo, encoding: 'utf8', timeout: 15_000, env: { ...env, ...extraEnv } },
    )
  return { ...fixture, output, run }
}

test('tag CLI rejects an unsigned tag with the enforcement environment opt-in', async (t) => {
  const fixture = await tagCliFixture(t)
  const result = fixture.run({ ENFORCE_SIGNED_TAGS: 'true' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Release tag signature verification failed/)
  await assert.rejects(readFile(fixture.output), { code: 'ENOENT' })
})

test('tag CLI warns by default and writes the inspected commit output', async (t) => {
  const fixture = await tagCliFixture(t)
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /::warning::.*signed-tag enforcement is off/)
  assert.match(result.stdout, /release-tag: v1\.2\.3; signature not verified \(warn-only\)/)
  assert.equal(await readFile(fixture.output, 'utf8'), `commit=${fixture.commit}\n`)
})

test('fixed-advisory approval does not cover another draft advisory', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const { api } = apiFixture({
    advisories: [
      { ghsa_id: 'GHSA-aaaa-bbbb-cccc', state: 'draft' },
      { ghsa_id: 'GHSA-dddd-eeee-ffff', state: 'draft' },
    ],
  })
  const result = await checkReleaseSecurity({
    repo: 'example/sdk',
    tag: 'v1.2.3',
    api,
    approval: JSON.stringify({ tag: 'v1.2.3', advisories: ['GHSA-aaaa-bbbb-cccc'] }),
  })
  assert.deepEqual(result.holds, ['HOLD: 1 draft or triage advisories need resolution'])
  assert.deepEqual(result.notes, [
    '1 draft advisories declared fixed for this release; publish them after tagging',
  ])
})

for (const [name, advisories] of [
  ['an invalid advisory ID', ['not-an-advisory']],
  ['a non-array advisory list', 'GHSA-aaaa-bbbb-cccc'],
]) {
  test(`fixed-advisory approval rejects ${name}`, async () => {
    const { checkReleaseSecurity } = await import('./release-security-check.mjs')
    await assert.rejects(
      checkReleaseSecurity({
        repo: 'example/sdk',
        tag: 'v1.2.3',
        api: apiFixture().api,
        approval: JSON.stringify({ tag: 'v1.2.3', advisories }),
      }),
      /Private security approval must name this exact release tag and advisory IDs/,
    )
  })
}

test('security gate queries the explicitly configured default branch', async () => {
  const { checkReleaseSecurity } = await import('./release-security-check.mjs')
  const { api, paths } = apiFixture()
  const result = await checkReleaseSecurity({
    repo: 'example/sdk',
    tag: 'v1.2.3',
    api,
    defaultBranch: 'release/default',
  })
  assert.deepEqual(result.holds, [])
  assert.deepEqual(
    paths.filter((path) => path.includes('/code-scanning/')),
    [
      'repos/example/sdk/code-scanning/alerts?state=open&per_page=100&ref=refs%2Fheads%2Frelease%2Fdefault',
    ],
  )
})

test('malformed milestone readiness data is an UNVERIFIED rejection', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  await assert.rejects(
    checkReleaseMilestone({
      repo: 'example/sdk',
      tag: 'v1.2.3',
      api: apiFixture({ items: {} }).api,
    }),
    /UNVERIFIED: release milestone readiness could not be checked/,
  )
})

for (const [name, env] of [
  ['a branch dispatch', { GITHUB_REF: 'refs/heads/main' }],
  ['another tag dispatch', { GITHUB_REF: 'refs/tags/v1.2.4' }],
  ['another event commit', { GITHUB_SHA: '0'.repeat(40) }],
  ['a missing event commit', { GITHUB_SHA: '' }],
]) {
  test(`tag CLI rejects ${name} before emitting an artifact commit`, async (t) => {
    const fixture = await tagCliFixture(t)
    const result = fixture.run(env)
    assert.equal(result.status, 1, 'the tag must match both the workflow ref and event commit')
    assert.match(result.stderr, /workflow must run from the requested tag and its inspected commit/)
    await assert.rejects(readFile(fixture.output), { code: 'ENOENT' })
  })
}

test('non-array milestone records are an UNVERIFIED rejection', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  await assert.rejects(
    checkReleaseMilestone({
      repo: 'example/sdk',
      tag: 'v1.2.3',
      api: apiFixture({ milestones: {} }).api,
    }),
    /UNVERIFIED: release milestone could not be read/,
  )
})

test('milestone issue-list API errors are an UNVERIFIED rejection', async () => {
  const { checkReleaseMilestone } = await import('./verify-release-milestone.mjs')
  const fixture = apiFixture()
  await assert.rejects(
    checkReleaseMilestone({
      repo: 'example/sdk',
      tag: 'v1.2.3',
      api: async (path) => {
        if (path.includes('/issues?')) throw new Error('fixture issue-list failure')
        return fixture.api(path)
      },
    }),
    /UNVERIFIED: release milestone readiness could not be checked/,
  )
})

for (const [name, blocked] of [
  ['clear', false],
  ['held', true],
]) {
  test(`security CLI exits ${blocked ? 1 : 0} for ${name} triage`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'b2-security-cli-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const preload = join(root, 'github-fixture.mjs')
    await writeFile(
      preload,
      `import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
const original = childProcess.spawnSync
childProcess.spawnSync = (program, args, options) => {
  if (program !== 'gh') return original(program, args, options)
  const alerts = ${blocked} && args.at(-1).includes('/code-scanning/') ? [{ number: 1 }] : []
  return { status: 0, stdout: JSON.stringify([alerts]), stderr: '' }
}
syncBuiltinESMExports()
`,
    )
    const script = join(dirname(fileURLToPath(import.meta.url)), 'release-security-check.mjs')
    const env = { ...process.env, GITHUB_DEFAULT_BRANCH: 'main' }
    delete env.RELEASE_SECURITY_APPROVAL
    const result = spawnSync(
      process.execPath,
      ['--import', preload, script, 'v1.2.3', 'example/sdk'],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env,
      },
    )
    assert.equal(result.status, blocked ? 1 : 0, result.stderr)
    if (blocked) {
      assert.match(result.stderr, /HOLD: 1 code-scanning alerts are open on the default branch/)
      assert.doesNotMatch(result.stdout, /triage gate passed/)
    } else {
      assert.match(result.stdout, /release-security: triage gate passed/)
      assert.equal(result.stderr, '')
    }
  })
}

test('release tag parsing accepts full release names and rejects other refs', async () => {
  const { releaseTag } = await import('./release-policy-common.mjs')
  for (const [input, expected] of [
    ['v0.0.0', 'v0.0.0'],
    ['refs/tags/v1.2.3', 'v1.2.3'],
    ['v1.2.3-rc.1+build.2', 'v1.2.3-rc.1+build.2'],
  ]) {
    assert.equal(releaseTag(input), expected)
  }
  for (const input of ['', '1.2.3', 'v1.2', 'v01.2.3', 'refs/heads/v1.2.3', 'v1.2.3\n', '--help']) {
    assert.throws(() => releaseTag(input), /A release tag such as v1.2.3 is required/)
  }
})
