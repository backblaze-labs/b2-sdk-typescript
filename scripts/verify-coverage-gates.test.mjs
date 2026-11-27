// The coverage config has two per-path gates and no global one: the SDK
// (src/ without src/simulator/) and the embedded simulator (src/simulator/).
// Vitest matches each gate's glob with picomatch and silently passes a gate
// whose glob matches no file, so this checks that the two globs split every
// covered source file between them, with no file in both or in neither.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
// The same matcher Vitest uses for threshold globs, resolved from Vitest itself.
const vitestDir = realpathSync(join(repo, 'node_modules/vitest'))
const picomatch = createRequire(join(vitestDir, 'package.json'))('picomatch')

function thresholdGlobs(config) {
  const block = config.match(/thresholds:\s*\{([\s\S]*?)\n {6}\},/)?.[1] ?? ''
  return {
    globs: [...block.matchAll(/^ {8}'([^']+)':\s*\{/gm)].map((m) => m[1]),
    hasGlobalGate: /^ {8}(?:statements|lines|functions|branches):/m.test(block),
  }
}

// The coverage `exclude` list, read from the config so the two cannot drift.
function coverageExcludes(config) {
  const coverage = config.slice(config.indexOf('coverage: {'))
  const list = coverage.match(/\bexclude:\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const globs = [...list.replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(globs.includes('src/test-utils/**'), 'coverage exclude list not found')
  return globs
}

function coveredSources(config) {
  const excluded = picomatch(coverageExcludes(config))
  return readdirSync(join(repo, 'src'), { recursive: true })
    .map((file) =>
      relative(repo, join(repo, 'src', file))
        .split(sep)
        .join('/'),
    )
    .filter((file) => file.endsWith('.ts') && !excluded(file))
}

function partitionErrors(config, files) {
  const { globs, hasGlobalGate } = thresholdGlobs(config)
  const errors = []
  if (hasGlobalGate) errors.push('a global gate would mix the SDK and the simulator')
  const sdk = globs.find((glob) => !glob.startsWith('src/simulator/'))
  const simulator = globs.find((glob) => glob.startsWith('src/simulator/'))
  if (globs.length !== 2 || sdk === undefined || simulator === undefined) {
    return [...errors, `expected one SDK and one src/simulator/ gate, found ${globs.join(', ')}`]
  }
  const inSdk = picomatch(sdk)
  const inSimulator = picomatch(simulator)
  for (const file of files) {
    const want = file.startsWith('src/simulator/') ? 'simulator' : 'sdk'
    const got = [inSdk(file) && 'sdk', inSimulator(file) && 'simulator'].filter(Boolean)
    if (got.length !== 1 || got[0] !== want)
      errors.push(`${file}: gates [${got}], expected ${want}`)
  }
  return errors
}

// Windows checkouts may have CRLF line endings.
const config = readFileSync(join(repo, 'vitest.coverage.config.ts'), 'utf8').replaceAll(
  '\r\n',
  '\n',
)
const files = coveredSources(config)

test('every covered source file is in exactly one coverage gate', () => {
  assert.ok(files.includes('src/client.ts'))
  assert.ok(files.includes('src/simulator/index.ts'))
  assert.ok(files.some((file) => /^src\/[^/]+\/[^/]+\/.+\.ts$/.test(file)))
  assert.deepEqual(partitionErrors(config, files), [])
})

test('the check fails when the SDK glob misses nested files or a global gate returns', () => {
  const shallow = config.replace("'src/{*.ts,!(simulator)/**}'", "'src/{*.ts,!(simulator)/*.ts}'")
  assert.notEqual(shallow, config)
  assert.notDeepEqual(partitionErrors(shallow, files), [])
  const overlapping = config.replace("'src/{*.ts,!(simulator)/**}'", "'src/**'")
  assert.notDeepEqual(partitionErrors(overlapping, files), [])
  const global = config.replace('thresholds: {', 'thresholds: {\n        statements: 97,')
  assert.notDeepEqual(partitionErrors(global, files), [])
})
