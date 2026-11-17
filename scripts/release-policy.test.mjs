import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  const fetchKey = async () => new Response('', { status: 503 })
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey }),
    /key|signature/i,
  )
})

test('tag verification stays bound to the object inspected before key lookup', async (t) => {
  const fixture = await tagFixture(t)
  command(
    'git',
    [
      '-c',
      'gpg.format=ssh',
      '-c',
      `user.signingkey=${fixture.key}`,
      'tag',
      '-s',
      'v1.2.4',
      '-m',
      'fixture',
    ],
    fixture.repo,
  )
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
  await assert.rejects(
    verifyReleaseTag({ ...fixture, tag: 'v1.2.3', enforce: true, fetchKey }),
    /signature/i,
  )
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

test('tag enforcement defaults off and rejects an invalid switch value', async () => {
  const { enforceSignedTags } = await import('./verify-release-tag.mjs')
  assert.equal(enforceSignedTags(), false)
  assert.equal(enforceSignedTags('false'), false)
  assert.equal(enforceSignedTags('true'), true)
  assert.throws(() => enforceSignedTags('treu'), /ENFORCE_SIGNED_TAGS/)
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
