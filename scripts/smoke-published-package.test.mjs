import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { walkFiles } from './package-export-probes.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repo, 'scripts', 'smoke-published-package.mjs')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

function runNode(args, options) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      B2_SMOKE_IMPORT_TIMEOUT_MS: '10000',
      B2_SMOKE_INSTALL_TIMEOUT_MS: '10000',
    },
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

function runNpm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true })
}

function writeExportFile(packageRoot, rel, contents) {
  const file = join(packageRoot, rel)
  ensureParent(file)
  writeFileSync(file, contents)
}

function maliciousPrelude(format, secretPath) {
  if (format === 'esm') {
    return `
import { readFileSync } from 'node:fs'
import net from 'node:net'
if (process.env.B2_SMOKE_SECRET) {
  throw new Error('environment secret leaked')
}
try {
  const secret = readFileSync(${JSON.stringify(secretPath)}, 'utf8')
  throw new Error('filesystem secret was readable: ' + secret)
} catch (error) {
  if (String(error?.message ?? '').startsWith('filesystem secret was readable')) throw error
}
try {
  new net.Socket().connect(9, '127.0.0.1')
  throw new Error('network API was not blocked')
} catch (error) {
  if (String(error?.message ?? '') === 'network API was not blocked') throw error
}
`
  }

  return `
const { readFileSync } = require('node:fs')
const net = require('node:net')
if (process.env.B2_SMOKE_SECRET) {
  throw new Error('environment secret leaked')
}
try {
  const secret = readFileSync(${JSON.stringify(secretPath)}, 'utf8')
  throw new Error('filesystem secret was readable: ' + secret)
} catch (error) {
  if (String(error && error.message || '').startsWith('filesystem secret was readable')) throw error
}
try {
  new net.Socket().connect(9, '127.0.0.1')
  throw new Error('network API was not blocked')
} catch (error) {
  if (String(error && error.message || '') === 'network API was not blocked') throw error
}
`
}

function esmExports(subpath) {
  switch (subpath) {
    case '.':
      return `
export function B2Client() {}
export const VERSION = ${JSON.stringify(pkg.version)}
export const BucketType = { AllPublic: 'allPublic' }
`
    case './raw':
      return 'export function RawClient() {}\n'
    case './errors':
      return 'export function B2Error() {}\nexport function classifyError() {}\n'
    case './auth':
      return 'export function InMemoryAccountInfo() {}\nexport function getRealmUrl() {}\n'
    case './auth/file':
      return 'export function FileAccountInfo() {}\n'
    case './partner':
      return `
export function PartnerClient() {}
export function PartnerRawClient() {}
export function InMemoryPartnerAccountInfo() {}
export const PartnerCapability = { All: 'all' }
`
    case './backup':
      return `
export function BackupClient() {}
export function BackupRawClient() {}
export function InMemoryPartnerAccountInfo() {}
export const PartnerCapability = { All: 'all' }
export function accountId() {}
export function computerId() {}
export function partnerToken() {}
`
    case './streams':
      return `
export function BufferSource() {}
export function IncrementalSha1() {}
export function sha1Hex() {}
`
    case './sync':
      return `
export function synchronize() {}
export function LocalFolder() {}
export function B2Folder() {}
`
    case './simulator':
      return 'export function B2Simulator() {}\nexport const BUCKET_NAME_MIN = 6\n'
    case './notifications':
      return `
export function verifyWebhookSignature() {}
export const B2_WEBHOOK_SIGNATURE_HEADER = 'X-Bz-Webhook-Signature'
`
    case './s3':
      return `
export function createS3ClientConfig() {}
export function presignS3GetObjectUrl() {}
export function presignS3PutObjectUrl() {}
export const trustedUnsafeS3PresignOptIn = {}
`
    default:
      throw new Error(`unexpected subpath ${subpath}`)
  }
}

function cjsExports(subpath) {
  switch (subpath) {
    case '.':
      return `
exports.B2Client = function B2Client() {}
exports.VERSION = ${JSON.stringify(pkg.version)}
exports.BucketType = { AllPublic: 'allPublic' }
`
    case './raw':
      return 'exports.RawClient = function RawClient() {}\n'
    case './errors':
      return `
exports.B2Error = function B2Error() {}
exports.classifyError = function classifyError() {}
`
    case './auth':
      return `
exports.InMemoryAccountInfo = function InMemoryAccountInfo() {}
exports.getRealmUrl = function getRealmUrl() {}
`
    case './auth/file':
      return 'exports.FileAccountInfo = function FileAccountInfo() {}\n'
    case './partner':
      return `
exports.PartnerClient = function PartnerClient() {}
exports.PartnerRawClient = function PartnerRawClient() {}
exports.InMemoryPartnerAccountInfo = function InMemoryPartnerAccountInfo() {}
exports.PartnerCapability = { All: 'all' }
`
    case './backup':
      return `
exports.BackupClient = function BackupClient() {}
exports.BackupRawClient = function BackupRawClient() {}
exports.InMemoryPartnerAccountInfo = function InMemoryPartnerAccountInfo() {}
exports.PartnerCapability = { All: 'all' }
exports.accountId = function accountId() {}
exports.computerId = function computerId() {}
exports.partnerToken = function partnerToken() {}
`
    case './streams':
      return `
exports.BufferSource = function BufferSource() {}
exports.IncrementalSha1 = function IncrementalSha1() {}
exports.sha1Hex = function sha1Hex() {}
`
    case './sync':
      return `
exports.synchronize = function synchronize() {}
exports.LocalFolder = function LocalFolder() {}
exports.B2Folder = function B2Folder() {}
`
    case './simulator':
      return 'exports.B2Simulator = function B2Simulator() {}\nexports.BUCKET_NAME_MIN = 6\n'
    case './notifications':
      return `
exports.verifyWebhookSignature = function verifyWebhookSignature() {}
exports.B2_WEBHOOK_SIGNATURE_HEADER = 'X-Bz-Webhook-Signature'
`
    case './s3':
      return `
exports.createS3ClientConfig = function createS3ClientConfig() {}
exports.presignS3GetObjectUrl = function presignS3GetObjectUrl() {}
exports.presignS3PutObjectUrl = function presignS3PutObjectUrl() {}
exports.trustedUnsafeS3PresignOptIn = {}
`
    default:
      throw new Error(`unexpected subpath ${subpath}`)
  }
}

function createMaliciousFixture(root) {
  const packageRoot = join(root, 'fixture')
  const secretPath = join(root, 'caller-secret.txt')
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(secretPath, 'SHOULD_NOT_LEAK')
  writeFileSync(join(packageRoot, 'README.md'), '# fixture\n')
  writeFileSync(join(packageRoot, 'LICENSE'), 'MIT\n')
  writeFileSync(join(packageRoot, 'CHANGELOG.md'), '# changelog\n')
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        type: 'module',
        exports: pkg.exports,
        files: ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md'],
      },
      null,
      2,
    )}\n`,
  )

  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    writeExportFile(
      packageRoot,
      conditions.import.default,
      `${maliciousPrelude('esm', secretPath)}\n${esmExports(subpath)}`,
    )
    writeExportFile(
      packageRoot,
      conditions.require.default,
      `${maliciousPrelude('cjs', secretPath)}\n${cjsExports(subpath)}`,
    )
    writeExportFile(packageRoot, conditions.import.types, 'export {}\n')
    writeExportFile(packageRoot, conditions.require.types, 'export {}\n')
  }

  runNpm(['pack', '--silent', '--pack-destination', root], packageRoot)
  return join(root, `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${pkg.version}.tgz`)
}

test('smokes a relative tarball while blocking env, fs, and network access', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-sdk-smoke-test-'))
  try {
    const tarball = createMaliciousFixture(root)
    const result = runNode([script, `./${basename(tarball)}`], {
      cwd: root,
      env: { ...process.env, B2_SMOKE_SECRET: 'SHOULD_NOT_LEAK' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /esm smoke OK/)
    assert.match(result.stdout, /cjs smoke OK/)
    assert.doesNotMatch(result.stdout + result.stderr, /SHOULD_NOT_LEAK/)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('cleans up the temp project when install fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-sdk-smoke-test-'))
  try {
    const result = runNode([script, './missing.tgz'], { cwd: root })
    assert.notEqual(result.status, 0)
    const output = `${result.stdout}\n${result.stderr}`
    const match = output.match(/ in (\/[^\s]*b2-sdk-published-smoke-[^\s]+)/)
    assert.ok(match, output)
    assert.equal(existsSync(match[1]), false)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('redacts credentials in package specs before logging failures', () => {
  const result = runNode([script, 'https://user:ghp_SECRET@127.0.0.1:9/pkg.tgz'], {
    cwd: repo,
    env: { ...process.env, B2_SMOKE_INSTALL_TIMEOUT_MS: '1000' },
  })
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout + result.stderr, /ghp_SECRET/)
  assert.match(result.stdout + result.stderr, /https:\/\/127\.0\.0\.1:9\/pkg\.tgz/)
})

test('rejects dash-prefixed package specs', () => {
  const result = runNode([script, '--', '--registry=http://127.0.0.1:9'], { cwd: repo })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /package spec must not begin with "-"/)
})

test('walkFiles skips symlinks instead of following them', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-sdk-walk-test-'))
  try {
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'file.txt'), 'ok')
    symlinkSync(root, join(root, 'dir', 'loop'))
    symlinkSync('/etc/passwd', join(root, 'dir', 'outside-file'))

    const files = walkFiles(root)
    assert.deepEqual(files, [join(root, 'dir', 'file.txt')])
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
