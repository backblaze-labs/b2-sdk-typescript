'use strict';

// Static contract over every leaf: they all go through the shared guard, and
// none can drift back to a private import, credential, or bare-catch refusal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WIN32_SKIP = 'sdkharness leaves are shebang scripts and are not spawnable on win32';

const TESTS = path.resolve(__dirname, '..');
const leaves = [];
for (const dir of ['conformance', 'resilience']) {
  for (const file of fs.readdirSync(path.join(TESTS, dir))) {
    if (file.endsWith('.cjs')) leaves.push({ dir, file, source: fs.readFileSync(path.join(TESTS, dir, file), 'utf8') });
  }
}

test('every tests.tsv conformance/resilience scenario has a leaf, and there are 53', () => {
  assert.equal(leaves.length, 53);
});

for (const { dir, file, source } of leaves) {
  test(`${dir}/${file}: uses the shared guard`, () => {
    assert.match(source, /require\('\.\.\/lib\/guard\.cjs'\)/);
    assert.match(source, /guard\.scrubProxyEnv\(\)/);
    assert.match(source, /guard\.importBuiltSdk\(/);
    // No private SDK import path that could turn an import error into amber.
    assert.ok(!/await import\(/.test(source), 'direct import() bypasses guard.importBuiltSdk');
    // Credentials come from the guard, never a literal.
    assert.ok(!/'test-key(-id)?'/.test(source), 'literal credential outside the guard');
    // Simulator and control URLs are read only through the guard.
    assert.ok(
      !/process\.env\.(CONFORMANCE|RESILIENCE)_(SIMULATOR(_HTTPS)?|CONTROL)_URL/.test(source),
      'raw simulator/control URL read bypasses guard.originFromEnv',
    );
  });

  test(`${dir}/${file}: an SDK import error is a Failure, only a missing build is amber`, () => {
    assert.match(source, /broken: \(detail\) => new Failure\('import', detail\)/);
    assert.match(source, /missing: \(detail\) => new Amber\('missing-runtime', detail\)/);
  });
}

for (const scenario of ['enc.sse_c', 'keys.multi_bucket', 'lock.legal_hold', 'lock.per_file_retention']) {
  test(`conformance/${scenario}: the refusal asserts the specific error, not any throw`, () => {
    const { source } = leaves.find((l) => l.dir === 'conformance' && l.file === `${scenario}.cjs`);
    assert.ok(!/refused = true/.test(source), 'bare catch { refused = true }');
    assert.match(source, /guard\.capture\(/);
    assert.match(source, /guard\.explainMismatch\(refusal, \{/);
    assert.match(source, /refused for the wrong reason/);
  });
}

// Run a real leaf against a copy of this tree whose dist/ is the dictated state.
function leafRun(distSource, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkharness-leaf-'));
  fs.cpSync(path.resolve(TESTS, '..'), path.join(root, '.sdkharness'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@backblaze-labs/b2-sdk',
      type: 'module',
      exports: { '.': { import: { default: './dist/index.js' } } },
    }),
  );
  if (distSource !== null) {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), distSource);
  }
  const result = spawnSync(
    process.execPath,
    [path.join(root, '.sdkharness', 'tests', 'conformance', 'files.upload.cjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CONFORMANCE_SIMULATOR_URL: 'http://127.0.0.1:9', ...env },
    },
  );
  const line = result.stdout.split('\n').find((l) => l.startsWith('CONFORMANCE ')) || '';
  return { status: result.status, verdict: line.replace(/^[^:]*: /, '') };
}

test('leaf run: no build at all is COULD-NOT-RUN, exit 0', { skip: process.platform === 'win32' && WIN32_SKIP }, () => {
  const { status, verdict } = leafRun(null);
  assert.equal(status, 0);
  assert.match(verdict, /^COULD-NOT-RUN \(missing-runtime -- .*build this exact checkout first/);
});

test('leaf run: a built SDK that throws on import is FAIL, exit 1', { skip: process.platform === 'win32' && WIN32_SKIP }, () => {
  const { status, verdict } = leafRun("throw new Error('sdk exploded at import')");
  assert.equal(status, 1);
  assert.match(verdict, /^FAIL \(import -- .*sdk exploded at import/);
});

test('leaf run: a non-loopback simulator URL is refused before anything is dialed', { skip: process.platform === 'win32' && WIN32_SKIP }, () => {
  for (const url of ['https://nonexistent.invalid', 'http://[::1]:9', 'http://localhost:9']) {
    const { status, verdict } = leafRun('export class B2Client {}', { CONFORMANCE_SIMULATOR_URL: url });
    assert.equal(status, 1);
    assert.match(verdict, /^FAIL \(configuration -- CONFORMANCE_SIMULATOR_URL must be http:\/\/127\.0\.0\.1:<port>/);
  }
});
