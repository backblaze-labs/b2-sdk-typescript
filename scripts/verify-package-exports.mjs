#!/usr/bin/env node
// Verify every file referenced by `package.json#exports` exists on disk
// AND that both ESM (`import`) and CJS (`require`) consumers can resolve the
// public entry points against the freshly-packed tarball.
//
// Catches two failure modes the build itself doesn't:
//
//   1. **Missing .d.cts mirror.** vite-plugin-dts only emits `.d.ts`. If
//      `scripts/build-cts-types.mjs` is removed or its glob is broken, the
//      `require.types` entries in `package.json#exports` (which point at
//      `.d.cts` files) silently dangle — `attw` flags it but CI couldn't
//      historically tell, and `pnpm test` doesn't touch dist/. This script
//      asserts every referenced file exists.
//
//   2. **Broken runtime resolution.** A typo in the `exports` map, a missing
//      barrel re-export, or an accidental `external` rollup entry can leave
//      consumers unable to `import` or `require` the package even though
//      every file is present. We pack the SDK into a tarball, install it
//      into an ephemeral `/tmp/...` project, then `import` and `require` it
//      from a subprocess. Failure surfaces the actual loader error.
//
// Run via `pnpm run verify:exports`. Also wired into the `build` script and
// `.github/workflows/{ci,release}.yml`.

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolvePath(here, '..')

function fail(msg) {
  console.error(`verify-package-exports: ${msg}`)
  process.exitCode = 1
}

function walkFiles(dir) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    const stats = statSync(file)
    if (stats.isDirectory()) {
      files.push(...walkFiles(file))
    } else {
      files.push(file)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// Step 1: walk package.json#exports, assert every referenced file exists.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(
  await import('node:fs').then((m) => m.promises.readFile(join(repo, 'package.json'), 'utf8')),
)

if (!pkg.exports || typeof pkg.exports !== 'object') {
  fail('package.json has no exports map; this script is meaningless without one.')
  process.exit(1)
}

let referencedFiles = 0
let missing = 0
for (const [subpath, conditions] of Object.entries(pkg.exports)) {
  if (typeof conditions !== 'object' || conditions === null) continue
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        referencedFiles += 1
        const file = join(repo, v)
        if (!existsSync(file)) {
          fail(`${subpath} → ${path.concat(k).join('.')} = "${v}" does not exist on disk`)
          missing += 1
        }
      } else if (typeof v === 'object' && v !== null) {
        walk(v, path.concat(k))
      }
    }
  }
  walk(conditions, [])
}

if (missing > 0) {
  console.error(
    `verify-package-exports: ${missing} of ${referencedFiles} referenced files are missing. Did the build run? Is scripts/build-cts-types.mjs still wired in?`,
  )
  process.exit(1)
}

// Belt-and-braces: confirm every `require.types` actually has a `.d.cts`
// extension (not `.d.ts`). The d.cts mirror is exactly what was broken
// before — make the assertion explicit so a future hand-edit of exports
// map can't silently regress.
let dctsTypeEntries = 0
for (const conditions of Object.values(pkg.exports)) {
  if (typeof conditions !== 'object' || conditions === null) continue
  if (conditions.require?.types) {
    dctsTypeEntries += 1
    if (!conditions.require.types.endsWith('.d.cts')) {
      fail(
        `CJS branch "${conditions.require.types}" should end in .d.cts (TypeScript nodenext resolution treats .d.ts as ESM).`,
      )
    }
  }
}

if (dctsTypeEntries === 0) {
  fail(
    'No exports entry has a require.types field — the dual-format type-resolution check is meaningless. Is the exports map intentionally ESM-only?',
  )
}

if (existsSync(join(repo, 'dist'))) {
  const forbiddenMetadataTokens = [
    '"devDependencies"',
    '"scripts"',
    '"packageManager"',
    '@vitest/coverage-v8',
  ]
  for (const file of walkFiles(join(repo, 'dist'))) {
    if (!/\.(?:cjs|js)$/.test(file)) continue
    const contents = readFileSync(file, 'utf8')
    for (const token of forbiddenMetadataTokens) {
      if (contents.includes(token)) {
        fail(
          `${file.slice(repo.length + 1)} includes package metadata token ${token}; the build should emit only VERSION-facing metadata.`,
        )
      }
    }
  }
}

const publicExportProbes = [
  {
    subpath: '.',
    checks: [
      ["typeof entry.B2Client === 'function'", 'B2Client runtime export missing'],
      ["typeof entry.VERSION === 'string' && entry.VERSION.length > 0", 'VERSION export missing'],
      ["entry.BucketType?.AllPublic === 'allPublic'", 'BucketType enum export drifted'],
    ],
  },
  {
    subpath: './raw',
    checks: [["typeof entry.RawClient === 'function'", 'RawClient runtime export missing']],
  },
  {
    subpath: './errors',
    checks: [
      ["typeof entry.B2Error === 'function'", 'B2Error runtime export missing'],
      ["typeof entry.classifyError === 'function'", 'classifyError runtime export missing'],
    ],
  },
  {
    subpath: './auth',
    checks: [
      ["typeof entry.InMemoryAccountInfo === 'function'", 'InMemoryAccountInfo export missing'],
      ["typeof entry.getRealmUrl === 'function'", 'getRealmUrl export missing'],
    ],
  },
  {
    subpath: './auth/file',
    checks: [["typeof entry.FileAccountInfo === 'function'", 'FileAccountInfo export missing']],
  },
  {
    subpath: './streams',
    checks: [
      ["typeof entry.BufferSource === 'function'", 'BufferSource export missing'],
      ["typeof entry.IncrementalSha1 === 'function'", 'IncrementalSha1 export missing'],
      ["typeof entry.sha1Hex === 'function'", 'sha1Hex export missing'],
    ],
  },
  {
    subpath: './sync',
    checks: [
      ["typeof entry.synchronize === 'function'", 'synchronize export missing'],
      ["typeof entry.LocalFolder === 'function'", 'LocalFolder export missing'],
      ["typeof entry.B2Folder === 'function'", 'B2Folder export missing'],
    ],
  },
  {
    subpath: './simulator',
    checks: [
      ["typeof entry.B2Simulator === 'function'", 'B2Simulator export missing'],
      ["typeof entry.BUCKET_NAME_MIN === 'number'", 'simulator constants missing'],
    ],
  },
  {
    subpath: './notifications',
    checks: [
      [
        "typeof entry.verifyWebhookSignature === 'function'",
        'verifyWebhookSignature export missing',
      ],
      ["typeof entry.B2_WEBHOOK_SIGNATURE_HEADER === 'string'", 'webhook header export missing'],
    ],
  },
  {
    subpath: './s3',
    checks: [
      ["typeof entry.createS3ClientConfig === 'function'", 'createS3ClientConfig export missing'],
      ["typeof entry.presignS3GetObjectUrl === 'function'", 'presignS3GetObjectUrl export missing'],
      ["typeof entry.presignS3PutObjectUrl === 'function'", 'presignS3PutObjectUrl export missing'],
      ["typeof entry.trustedUnsafeS3PresignOptIn === 'object'", 'trusted S3 opt-in token missing'],
    ],
  },
]

const exportedSubpaths = Object.keys(pkg.exports).filter(
  (subpath) => subpath === '.' || subpath.startsWith('./'),
)
const probedSubpaths = new Set(publicExportProbes.map(({ subpath }) => subpath))
for (const subpath of exportedSubpaths) {
  if (!probedSubpaths.has(subpath)) {
    fail(`package export "${subpath}" has no runtime smoke probe`)
  }
}
for (const subpath of probedSubpaths) {
  if (!exportedSubpaths.includes(subpath)) {
    fail(`runtime smoke probe references missing package export "${subpath}"`)
  }
}

if (process.exitCode) process.exit(1)

function packageSpecifier(subpath) {
  return subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`
}

function buildRuntimeProbeSource(format) {
  const lines = []

  if (format === 'esm') {
    publicExportProbes.forEach((probe, index) => {
      lines.push(
        `import * as entry${index} from ${JSON.stringify(packageSpecifier(probe.subpath))};`,
      )
    })
  }

  lines.push('function assert(ok, msg) { if (!ok) throw new Error(msg); }')
  lines.push(`const expectedProbeCount = ${publicExportProbes.length};`)

  publicExportProbes.forEach((probe, index) => {
    const entryExpression =
      format === 'esm'
        ? `entry${index}`
        : `require(${JSON.stringify(packageSpecifier(probe.subpath))})`
    lines.push('{')
    lines.push(`  const entry = ${entryExpression};`)
    lines.push(
      `  assert(entry && typeof entry === 'object', ${JSON.stringify(
        `${packageSpecifier(probe.subpath)} did not load an object namespace`,
      )});`,
    )
    for (const [expression, message] of probe.checks) {
      lines.push(`  assert(${expression}, ${JSON.stringify(`${probe.subpath}: ${message}`)});`)
    }
    lines.push('}')
  })

  lines.push("assert(expectedProbeCount > 0, 'no runtime probes configured');")
  if (format === 'esm') {
    lines.push("console.log('esm-ok ' + entry0.VERSION + ' ' + expectedProbeCount);")
  } else {
    lines.push(
      `console.log('cjs-ok ' + require(${JSON.stringify(pkg.name)}).VERSION + ' ' + expectedProbeCount);`,
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Step 2: pack + install + import/require the package end-to-end.
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'b2-sdk-resolve-'))
let packedTarball

try {
  // Pack into the scratch dir so a stale tarball in /tmp can't confuse us.
  const pack = spawnSync('pnpm', ['pack', '--pack-destination', scratch], {
    cwd: repo,
    encoding: 'utf8',
  })
  if (pack.status !== 0) {
    fail(`pnpm pack failed: ${pack.stderr || pack.stdout}`)
    process.exit(1)
  }
  // The last non-empty line of `pnpm pack`'s output is the absolute tarball path.
  packedTarball = (pack.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '').trim()
  if (!packedTarball || !existsSync(packedTarball)) {
    fail(`could not determine tarball path from pnpm pack output:\n${pack.stdout}`)
    process.exit(1)
  }

  // Minimal consumer package.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'resolve-smoke', version: '0.0.0', private: true }, null, 2),
  )

  // Use npm here (not pnpm) for the install — pnpm's symlink layout means
  // CJS resolution against scoped tarballs can take a different code path
  // than what end-users see. npm produces a flat node_modules that mirrors
  // the npm registry layout, which is the worst-case we want to test.
  const install = spawnSync('npm', ['install', '--silent', '--no-save', packedTarball], {
    cwd: scratch,
    encoding: 'utf8',
  })
  if (install.status !== 0) {
    fail(`npm install of packed tarball failed:\n${install.stderr || install.stdout}`)
    process.exit(1)
  }

  // ESM probe: import every public runtime subpath from the packed package.
  const esmProbe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', buildRuntimeProbeSource('esm')],
    { cwd: scratch, encoding: 'utf8' },
  )
  if (esmProbe.status !== 0) {
    fail(`ESM import probe of ${pkg.name} failed:\n${esmProbe.stderr || esmProbe.stdout}`)
    process.exit(1)
  }
  if (!esmProbe.stdout.startsWith('esm-ok ')) {
    fail(`ESM probe produced unexpected output: ${esmProbe.stdout}`)
    process.exit(1)
  }

  // CJS probe: require every public runtime subpath from the packed package.
  const cjsProbe = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '-e', buildRuntimeProbeSource('cjs')],
    { cwd: scratch, encoding: 'utf8' },
  )
  if (cjsProbe.status !== 0) {
    fail(`CJS require probe of ${pkg.name} failed:\n${cjsProbe.stderr || cjsProbe.stdout}`)
    process.exit(1)
  }
  if (!cjsProbe.stdout.startsWith('cjs-ok ')) {
    fail(`CJS probe produced unexpected output: ${cjsProbe.stdout}`)
    process.exit(1)
  }

  const version = esmProbe.stdout.trim().split(' ')[1]
  console.log(
    `verify-package-exports: OK (${referencedFiles} files referenced, ${dctsTypeEntries} .d.cts entries, ${publicExportProbes.length} subpath probes, dual-format resolve at v${version})`,
  )
} finally {
  // Best-effort cleanup. Leftover scratch dir under /tmp survives a reboot
  // anyway and the OS sweeps it eventually.
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
