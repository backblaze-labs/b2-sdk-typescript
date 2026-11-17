import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isEntry, releaseTag } from './release-policy-common.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sshKey =
  /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[\w-]+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z\d+/]+=*(?: .*)?$/

export function enforceSignedTags(value = '') {
  if (['', 'false', '0', 'off'].includes(value.trim().toLowerCase())) return false
  if (['true', '1', 'on'].includes(value.trim().toLowerCase())) return true
  throw new Error('ENFORCE_SIGNED_TAGS must be true or false')
}

async function maintainerKeys(username, fetchKey) {
  const urls = [
    `https://github.com/${username}.gpg`,
    `https://github.com/${username}.keys`,
    // GitHub's .keys feed does not include keys registered only for signing.
    `https://api.github.com/users/${username}/ssh_signing_keys`,
  ]
  const [gpg, ssh, signing] = await Promise.all(
    urls.map(async (url) => {
      const response = await fetchKey(url, { signal: AbortSignal.timeout(10_000) })
      if (response.status === 404) return url.endsWith('ssh_signing_keys') ? '[]' : ''
      if (!response.ok) throw new Error('Public key source unavailable')
      const text = await response.text()
      if (text.length > 2 * 1024 * 1024) throw new Error('Unexpected public key response')
      return text
    }),
  )
  const registered = JSON.parse(signing || '[]')
  if (!Array.isArray(registered) || !registered.every((key) => typeof key?.key === 'string')) {
    throw new Error('Unexpected signing-key response')
  }
  const keys = [...ssh.split('\n'), ...registered.map((key) => key.key)]
    .map((key) => key.trim())
    .filter(Boolean)
  if (keys.some((key) => !sshKey.test(key))) throw new Error('Unexpected SSH public key')
  if (gpg.trim() && !gpg.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    throw new Error('Unexpected GPG public key')
  }
  return { username, gpg, ssh: [...new Set(keys)] }
}

function isGithubEmptyGpg(value) {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  // Only GitHub's known empty response counts as absent; other invalid armor is an error.
  return (
    lines.join('\n') ===
    [
      '-----BEGIN PGP PUBLIC KEY BLOCK-----',
      "Note: This user hasn't uploaded any GPG keys.",
      '=twTO',
      '-----END PGP PUBLIC KEY BLOCK-----',
    ].join('\n')
  )
}

function inspectGpgKeys(keys, home, env, warnings) {
  for (const key of keys) {
    if (key.gpg.trim()) {
      const inspected = spawnSync(
        'gpg',
        ['--batch', '--homedir', home, '--with-colons', '--show-keys'],
        {
          env,
          input: key.gpg,
          encoding: 'utf8',
          timeout: 30_000,
        },
      )
      if (inspected.error) {
        warnings.push('Registered GPG key data could not be inspected')
      } else if (!/^pub:/m.test(inspected.stdout)) {
        if (!isGithubEmptyGpg(key.gpg)) warnings.push('Registered GPG key data is malformed')
        key.gpg = ''
      } else if (inspected.status !== 0) {
        warnings.push('Registered GPG key data could not be fully read')
      }
    }
    if (!key.gpg.trim() && key.ssh.length === 0) {
      warnings.push(`No signing keys enrolled for ${key.username}`)
    }
  }
}

export async function verifyReleaseTag({
  repo = root,
  tag: input,
  enforce = false,
  fetchKey = fetch,
} = {}) {
  const tag = releaseTag(input)
  const target = `refs/tags/${tag}`
  const objectResult = spawnSync('git', ['rev-parse', '--verify', target], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (objectResult.status !== 0) throw new Error('Release tag does not resolve to an object')
  const object = objectResult.stdout.trim()
  const commitResult = spawnSync('git', ['rev-parse', '--verify', `${object}^{commit}`], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (commitResult.status !== 0) throw new Error('Release tag does not resolve to a commit')
  const commit = commitResult.stdout.trim()
  if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error('Unexpected release tag commit')
  const maintainers = (await readFile(join(repo, '.github/signing-maintainers'), 'utf8'))
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)
  if (
    maintainers.length === 0 ||
    maintainers.some((name) => !/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/.test(name))
  ) {
    throw new Error('The signing-maintainers file must list GitHub usernames')
  }
  const warnings = []
  const annotation = spawnSync('git', ['cat-file', 'tag', object], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (
    annotation.status !== 0 ||
    !annotation.stdout.split('\n\n', 1)[0].split('\n').includes(`tag ${tag}`)
  ) {
    warnings.push('Tag annotation does not match the requested release name')
  }
  if (!/-----BEGIN (?:PGP|SSH) SIGNATURE-----/.test(annotation.stdout ?? '')) {
    warnings.push('Tag has no supported GPG or SSH signature')
  }
  const keys = (
    await Promise.all(
      maintainers.map(async (username) => {
        try {
          return await maintainerKeys(username, fetchKey)
        } catch {
          warnings.push(`Public signing keys could not be read for ${username}`)
          return null
        }
      }),
    )
  ).filter(Boolean)
  const directory = await mkdtemp(join(tmpdir(), 'b2-release-keyring-'))
  try {
    const home = join(directory, 'gnupg')
    const signers = join(directory, 'allowed-signers')
    const empty = join(directory, 'empty')
    await mkdir(home, { mode: 0o700 })
    await writeFile(empty, '')
    await writeFile(
      signers,
      keys
        .flatMap((key) => key.ssh.map((value) => `${key.username} namespaces="git" ${value}`))
        .join('\n'),
    )
    const env = {
      ...process.env,
      GNUPGHOME: home,
      GIT_CONFIG_GLOBAL: empty,
      GIT_CONFIG_NOSYSTEM: '1',
    }
    inspectGpgKeys(keys, home, env, warnings)
    const gpg = keys
      .map((key) => key.gpg.trim())
      .filter(Boolean)
      .join('\n')
    if (gpg) {
      const imported = spawnSync('gpg', ['--batch', '--homedir', home, '--import'], {
        env,
        input: gpg,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (imported.status !== 0) warnings.push('Registered GPG keys could not be imported')
    }
    const result = spawnSync(
      'git',
      [
        '-c',
        'gpg.program=gpg',
        '-c',
        'gpg.ssh.program=ssh-keygen',
        '-c',
        `gpg.ssh.allowedSignersFile=${signers}`,
        '-c',
        `gpg.ssh.revocationFile=${empty}`,
        'verify-tag',
        '--raw',
        object,
      ],
      { cwd: repo, env, encoding: 'utf8', timeout: 30_000 },
    )
    if (result.status !== 0)
      warnings.push('Tag signature could not be verified with registered maintainer keys')
    const verified = warnings.length === 0
    if (enforce && !verified)
      throw new Error(`Release tag signature verification failed: ${warnings.join('; ')}`)
    return { tag, commit, verified, warnings }
  } finally {
    spawnSync('gpgconf', ['--homedir', join(directory, 'gnupg'), '--kill', 'all'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    await rm(directory, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) {
  try {
    const result = await verifyReleaseTag({
      tag: process.argv[2],
      enforce: enforceSignedTags(process.env.ENFORCE_SIGNED_TAGS),
    })
    for (const warning of result.warnings)
      console.warn(`::warning::${warning} (signed-tag enforcement is off)`)
    console.log(
      `release-tag: ${result.tag}; signature ${result.verified ? 'verified' : 'not verified (warn-only)'}`,
    )
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `commit=${result.commit}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
