#!/usr/bin/env node
// Smoke a package spec that has already been packed or published.
//
// `verify:exports` is the local-checkout gate: it packs this repo and probes
// that tarball. This helper is the release-acceptance gate: it accepts a
// caller-supplied spec such as an already-packed `.tgz` or
// `@backblaze-labs/b2-sdk@latest`, installs it into a fresh project, and reuses
// the same public export probes against that installed artifact.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  checkProbeCoverage,
  packageSpecifier,
  publicExportProbes,
  walkFiles,
} from './package-export-probes.mjs'

const packageName = '@backblaze-labs/b2-sdk'
const repoPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedVersion = repoPackage.version
const pnpm = process.env.PNPM ?? 'pnpm'
const callerCwd = process.cwd()
const installTimeoutMs = Number(process.env.B2_SMOKE_INSTALL_TIMEOUT_MS ?? 5 * 60_000)
const importTimeoutMs = Number(process.env.B2_SMOKE_IMPORT_TIMEOUT_MS ?? 60_000)
const maxBuffer = 10 * 1024 * 1024

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message)
}

function parseArgs(argv) {
  let keepTemp = false
  let afterSeparator = false
  let packageSpec = null

  for (const arg of argv) {
    if (!afterSeparator && arg === '--') {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && arg === '--keep-temp') {
      keepTemp = true
      continue
    }
    if (!afterSeparator && arg.startsWith('--')) {
      fail(`unknown option ${arg}; pass the package spec after "--"`)
    }
    if (packageSpec !== null) {
      fail(`unexpected extra argument ${arg}`)
    }
    packageSpec = arg
  }

  packageSpec ??= `${packageName}@latest`
  if (packageSpec.startsWith('-')) {
    fail('package spec must not begin with "-"')
  }
  return { keepTemp, packageSpec }
}

function looksLikeLocalPackageSpec(spec) {
  if (spec.startsWith('file:')) return true
  try {
    const url = new URL(spec)
    if (url.protocol !== 'file:') return false
  } catch {
    // Not a URL; fall through to local path heuristics.
  }
  if (isAbsolute(spec) || spec.startsWith('.')) return true
  return /\.(?:tgz|tar\.gz|tar)$/i.test(spec)
}

function normalizePackageSpec(spec) {
  if (spec.startsWith('file:')) {
    const value = spec.slice('file:'.length)
    if (value.startsWith('//')) return spec
    return pathToFileURL(resolve(callerCwd, value)).href
  }
  if (looksLikeLocalPackageSpec(spec)) {
    return resolve(callerCwd, spec)
  }
  return spec
}

function redactPackageSpec(spec) {
  if (looksLikeLocalPackageSpec(spec)) {
    try {
      if (spec.startsWith('file:')) {
        return `local package ${basename(fileURLToPath(spec))}`
      }
    } catch {
      // Fall back to the raw basename path below.
    }
    return `local package ${basename(spec)}`
  }

  try {
    const url = new URL(spec)
    const hadSearch = url.search.length > 0
    return `${url.protocol}//${url.host}${url.pathname}${hadSearch ? '?[redacted-query]' : ''}`
  } catch {
    return spec
  }
}

function redactText(text, redactions) {
  let redacted = text
  for (const [secret, replacement] of redactions) {
    if (secret) redacted = redacted.split(secret).join(replacement)
  }
  return redacted
}

function commandText(command, args) {
  return [command, ...args].join(' ')
}

function run({ args, command, cwd, displayArgs = args, env, redactions = [], timeoutMs }) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  })
  const elapsed = Date.now() - started
  const stdout = redactText(result.stdout ?? '', redactions)
  const stderr = redactText(result.stderr ?? '', redactions)

  if (result.status !== 0 || result.error) {
    const reason = result.error?.message ?? `exit ${result.status ?? 'unknown'}`
    const output = [stdout, stderr].filter(Boolean).join('\n')
    fail(
      `${commandText(command, displayArgs)} failed in ${cwd} after ${elapsed}ms: ${reason}${
        output ? `\n${output}` : ''
      }`,
    )
  }

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return { elapsed, stderr, stdout }
}

function checkInstalledPackageFiles(project) {
  const packageDir = join(project, 'node_modules', '@backblaze-labs', 'b2-sdk')
  if (!existsSync(packageDir)) {
    fail(`${packageName} was not installed in node_modules`)
  }

  const realPackageDir = realpathSync(packageDir)
  const installedPkg = JSON.parse(readFileSync(join(realPackageDir, 'package.json'), 'utf8'))
  if (installedPkg.name !== packageName) {
    fail(`installed package name should be ${packageName} (found ${installedPkg.name})`)
  }
  if (installedPkg.version !== expectedVersion) {
    fail(`installed package VERSION should be ${expectedVersion} (found ${installedPkg.version})`)
  }
  if (!installedPkg.exports || typeof installedPkg.exports !== 'object') {
    fail('installed package has no package.json#exports map')
  }

  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']) {
    if (!existsSync(join(realPackageDir, file))) {
      fail(`installed package is missing ${file}`)
    }
  }

  let referencedFiles = 0
  let dctsTypeEntries = 0
  for (const [subpath, conditions] of Object.entries(installedPkg.exports)) {
    if (typeof conditions !== 'object' || conditions === null) continue
    const walk = (obj, path) => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
          referencedFiles += 1
          const file = resolve(realPackageDir, value)
          if (file !== realPackageDir && !file.startsWith(realPackageDir + sep)) {
            fail(`${subpath} -> ${path.concat(key).join('.')} escapes the package root`)
          }
          if (!existsSync(file)) {
            fail(`${subpath} -> ${path.concat(key).join('.')} = "${value}" is missing`)
          }
          if (path.at(-1) === 'require' && key === 'types') {
            dctsTypeEntries += 1
            if (!value.endsWith('.d.cts')) {
              fail(`${subpath} require.types should point at .d.cts (found "${value}")`)
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          walk(value, path.concat(key))
        }
      }
    }
    walk(conditions, [])
  }

  if (referencedFiles === 0) {
    fail('installed package exports map references no files')
  }
  if (dctsTypeEntries === 0) {
    fail('installed package exports map has no require.types .d.cts entries')
  }

  checkProbeCoverage(installedPkg, fail)

  const leakedSource = walkFiles(realPackageDir).filter((file) =>
    file.startsWith(join(realPackageDir, 'src') + sep),
  )
  if (leakedSource.length > 0) {
    fail(`installed package contains src/ files: ${leakedSource.length}`)
  }

  return { dctsTypeEntries, installedPkg, referencedFiles }
}

function networkBlockSource(format) {
  const requireSetup =
    format === 'esm'
      ? "const { createRequire, syncBuiltinESMExports } = await import('node:module');\nconst require = createRequire(import.meta.url);"
      : "const { syncBuiltinESMExports } = require('node:module');"

  return `
${requireSetup}
const blockedNetwork = () => {
  throw new Error('network disabled during release smoke import')
}
for (const mod of [require('node:http'), require('node:https')]) {
  mod.get = blockedNetwork
  mod.request = blockedNetwork
}
const net = require('node:net')
net.connect = blockedNetwork
net.createConnection = blockedNetwork
net.createServer = blockedNetwork
const tls = require('node:tls')
tls.connect = blockedNetwork
tls.createServer = blockedNetwork
const dgram = require('node:dgram')
dgram.createSocket = blockedNetwork
const dns = require('node:dns')
for (const key of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[key] === 'function') dns[key] = blockedNetwork
  if (dns.promises && typeof dns.promises[key] === 'function') dns.promises[key] = blockedNetwork
}
globalThis.fetch = blockedNetwork
globalThis.WebSocket = class {
  constructor() {
    blockedNetwork()
  }
}
syncBuiltinESMExports()
`
}

function buildRuntimeProbeSource(format, pkg) {
  const lines = [networkBlockSource(format)]

  lines.push('function assert(ok, msg) { if (!ok) throw new Error(msg) }')
  lines.push(`const expectedProbeCount = ${publicExportProbes.length}`)
  lines.push(`const expectedVersion = ${JSON.stringify(expectedVersion)}`)

  publicExportProbes.forEach((probe) => {
    const specifier = packageSpecifier(pkg.name, probe.subpath)
    const entryExpression =
      format === 'esm'
        ? `await import(${JSON.stringify(specifier)})`
        : `require(${JSON.stringify(specifier)})`
    lines.push('{')
    lines.push(`  const entry = ${entryExpression}`)
    lines.push(
      `  assert(entry && typeof entry === 'object', ${JSON.stringify(
        `${specifier} did not load an object namespace`,
      )})`,
    )
    if (probe.subpath === '.') {
      lines.push(
        `  assert(entry.VERSION === expectedVersion, ${JSON.stringify(
          `VERSION should be ${expectedVersion}`,
        )})`,
      )
    }
    for (const [expression, message] of probe.checks) {
      lines.push(`  assert(${expression}, ${JSON.stringify(`${probe.subpath}: ${message}`)})`)
    }
    lines.push('}')
  })

  lines.push("assert(expectedProbeCount > 0, 'no runtime probes configured')")
  lines.push(
    `console.log(${JSON.stringify(
      `${format} smoke OK via ${format === 'esm' ? 'await import' : 'require'}, VERSION = `,
    )} + ${format === 'esm' ? `((await import(${JSON.stringify(pkg.name)})).VERSION)` : `require(${JSON.stringify(pkg.name)}).VERSION`})`,
  )
  return lines.join('\n')
}

function sandboxEnv(project) {
  const home = join(project, '.sandbox-home')
  const temp = join(project, '.sandbox-tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(temp, { recursive: true })

  return {
    HOME: home,
    NO_COLOR: '1',
    PATH: process.env.PATH ?? '',
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, '.cache'),
    npm_config_cache: join(home, '.npm-cache'),
    npm_config_userconfig: join(home, '.npmrc'),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
  }
}

function runImportProbe(project, pkg, format) {
  const source = buildRuntimeProbeSource(format, pkg)
  const realProject = realpathSync(project)
  const nodeArgs = [
    '--permission',
    `--allow-fs-read=${project}`,
    `--allow-fs-read=${realProject}`,
    `--input-type=${format === 'esm' ? 'module' : 'commonjs'}`,
    '--eval',
    source,
  ]
  return run({
    args: nodeArgs,
    command: process.execPath,
    cwd: project,
    displayArgs: [
      '--permission',
      `--allow-fs-read=${project}`,
      `--allow-fs-read=${realProject}`,
      `--input-type=${format === 'esm' ? 'module' : 'commonjs'}`,
      '--eval',
      '<runtime probe>',
    ],
    env: sandboxEnv(project),
    timeoutMs: importTimeoutMs,
  })
}

const { keepTemp, packageSpec } = parseArgs(process.argv.slice(2))
const normalizedPackageSpec = normalizePackageSpec(packageSpec)
const redactedPackageSpec = redactPackageSpec(packageSpec)
const normalizedRedactedPackageSpec = redactPackageSpec(normalizedPackageSpec)
const redactions = [
  [packageSpec, redactedPackageSpec],
  [normalizedPackageSpec, normalizedRedactedPackageSpec],
]
const project = mkdtempSync(join(tmpdir(), 'b2-sdk-published-smoke-'))

try {
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  )

  console.log(`Installing ${redactedPackageSpec} in ${project}`)
  run({
    args: ['add', '--ignore-scripts', '--', normalizedPackageSpec],
    command: pnpm,
    cwd: project,
    displayArgs: ['add', '--ignore-scripts', '--', normalizedRedactedPackageSpec],
    redactions,
    timeoutMs: installTimeoutMs,
  })

  const { dctsTypeEntries, installedPkg, referencedFiles } = checkInstalledPackageFiles(project)
  runImportProbe(project, installedPkg, 'esm')
  runImportProbe(project, installedPkg, 'cjs')
  console.log(
    `smoke-published-package: ${redactedPackageSpec} passed (${referencedFiles} export files, ${dctsTypeEntries} .d.cts entries, ${publicExportProbes.length} subpath probes)`,
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`smoke-published-package: ${message}`)
  process.exitCode = 1
} finally {
  if (keepTemp) {
    console.log(`smoke-published-package: kept ${project}`)
  } else {
    rmSync(project, { force: true, recursive: true })
  }
}
