'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// The dispatchers are shebang scripts (bash/node) that Windows cannot spawn directly.
if (process.platform === 'win32') {
  test('dispatcher tests need a POSIX shell; skipped on win32', { skip: 'sdkharness dispatchers are shebang scripts and are not spawnable on win32' }, () => {});
  return;
}

const TESTS = path.resolve(__dirname, '..');
const SLUG = 'b2-sdk-typescript';

// run-resilience asks the control URL for /journal before it runs a check. spawnSync blocks this
// process, so the stub fresh-simulator journal server runs in a child process.
// Start a loopback stub that answers every request with `body` as JSON; resolves to { url, stop }.
async function startJournal(body) {
  const stub = spawn(
    process.execPath,
    [
      '-e',
      `require('node:http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(process.env.STUB_BODY); })
        .listen(0, '127.0.0.1', function () { console.log(this.address().port); });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, STUB_BODY: body } },
  );
  const port = await new Promise((resolve) => stub.stdout.once('data', (d) => resolve(String(d).trim())));
  return { url: `http://127.0.0.1:${port}`, stop: () => stub.kill() };
}

let freshJournal;
let journalUrl;
test.before(async () => {
  freshJournal = await startJournal('{"entries":[]}');
  journalUrl = freshJournal.url;
});
test.after(() => freshJournal?.stop());

async function withJournal(body, fn) {
  const stub = await startJournal(body);
  try {
    return fn(stub.url);
  } finally {
    stub.stop();
  }
}

// A copy of the real dispatchers and lib next to one fake leaf, so the real
// scripts run unmodified against a leaf whose behavior the test dictates.
function harness(level, scenario, leafBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkharness-dispatch-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, level));
  for (const name of [`run-${level}`]) {
    fs.copyFileSync(path.join(TESTS, name), path.join(dir, name));
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  for (const lib of ['contract.sh', 'guard.cjs']) {
    fs.copyFileSync(path.join(TESTS, 'lib', lib), path.join(dir, 'lib', lib));
  }
  const leaf = path.join(dir, level, `${scenario}.cjs`);
  fs.writeFileSync(leaf, `#!/usr/bin/env node\n${leafBody}\n`);
  fs.chmodSync(leaf, 0o755);
  return dir;
}

function run(dir, level, scenario, env = {}) {
  const base = {
    PATH: process.env.PATH,
    SDKHARNESS_TEST_LEVEL: level,
    SDKHARNESS_SCENARIO: scenario,
    SDKHARNESS_SIMULATOR_URL: 'http://127.0.0.1:9',
    SDKHARNESS_SIMULATOR_CONTROL_URL: journalUrl,
  };
  const result = spawnSync(path.join(dir, `run-${level}`), [], {
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('SDKHARNESS_RESULT')) || '';
  const [, , , outcome, detail] = line.split('\t');
  return { status: result.status, outcome, detail, stdout: result.stdout };
}

const standing = (level, scenario, verdict, code) =>
  `process.stdout.write(${JSON.stringify(
    `${level.toUpperCase()} ${SLUG} ${scenario} @simulator: ${verdict}\n`,
  )}); process.exit(${code});`;

for (const level of ['conformance', 'resilience']) {
  const scenario = 'fake.scenario';

  test(`${level}: COULD-NOT-RUN with a zero exit is SKIP`, () => {
    const dir = harness(level, scenario, standing(level, scenario, 'COULD-NOT-RUN (unreachable -- simulated)', 0));
    const result = run(dir, level, scenario);
    assert.equal(result.outcome, 'SKIP');
    assert.equal(result.detail, 'unreachable -- simulated');
    assert.equal(result.status, 0);
  });

  test(`${level}: COULD-NOT-RUN with a nonzero exit is FAIL, not amber`, () => {
    const dir = harness(level, scenario, standing(level, scenario, 'COULD-NOT-RUN (unreachable -- simulated)', 7));
    const result = run(dir, level, scenario);
    assert.equal(result.outcome, 'FAIL');
    assert.match(result.detail, /COULD-NOT-RUN exited 7/);
    assert.equal(result.status, 1);
  });

  test(`${level}: PASS with a nonzero exit is FAIL`, () => {
    const dir = harness(level, scenario, standing(level, scenario, 'PASS', 3));
    const result = run(dir, level, scenario);
    assert.equal(result.outcome, 'FAIL');
    assert.equal(result.status, 1);
  });

  test(`${level}: PASS with a zero exit is PASS`, () => {
    const dir = harness(level, scenario, standing(level, scenario, 'PASS', 0));
    const result = run(dir, level, scenario);
    assert.equal(result.outcome, 'PASS');
    assert.equal(result.status, 0);
  });

  for (const url of ['http://[::1]:9', 'http://localhost:9', 'https://127.0.0.1:9', 'https://api.backblazeb2.com']) {
    test(`${level}: refuses simulator URL ${url} without running the leaf`, () => {
      const dir = harness(level, scenario, 'process.stdout.write("LEAF RAN\\n")');
      const result = run(dir, level, scenario, { SDKHARNESS_SIMULATOR_URL: url });
      assert.equal(result.outcome, 'FAIL');
      assert.match(result.detail, /^configuration: /);
      assert.ok(!result.stdout.includes('LEAF RAN'));
    });
  }

  test(`${level}: refuses a non-loopback TLS URL`, () => {
    const dir = harness(level, scenario, 'process.stdout.write("LEAF RAN\\n")');
    const result = run(dir, level, scenario, { SDKHARNESS_SIMULATOR_HTTPS_URL: 'https://example.com:443' });
    assert.equal(result.outcome, 'FAIL');
    assert.ok(!result.stdout.includes('LEAF RAN'));
  });

  test(`${level}: the leaf never sees proxy variables`, () => {
    const dir = harness(
      level,
      scenario,
      `const seen = Object.keys(process.env).filter((n) => /proxy/i.test(n));
       process.stdout.write(${JSON.stringify(`${level.toUpperCase()} ${SLUG} ${scenario} @simulator: `)} +
         (seen.length === 0 ? 'PASS' : 'FAIL (proxy variables leaked: ' + seen.join(',') + ')') + '\\n');
       process.exit(seen.length === 0 ? 0 : 1);`,
    );
    const result = run(dir, level, scenario, {
      HTTP_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      ALL_PROXY: 'socks5://127.0.0.1:9',
      NO_PROXY: 'example.com',
      NODE_USE_ENV_PROXY: '1',
    });
    assert.equal(result.outcome, 'PASS', result.stdout);
  });
}

test('resilience: a simulator that already served a request is refused before the leaf runs', async () => {
  const dir = harness('resilience', 'fake.scenario', 'process.stdout.write("LEAF RAN\\n")');
  await withJournal('{"entries":[{}]}', (url) => {
    const result = run(dir, 'resilience', 'fake.scenario', { SDKHARNESS_SIMULATOR_CONTROL_URL: url });
    assert.equal(result.outcome, 'FAIL');
    assert.equal(result.detail.split(';')[0], 'configuration: the simulator already served 1 request(s)');
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes('LEAF RAN'));
  });
});

test('resilience: an unreachable journal is refused before the leaf runs', () => {
  const dir = harness('resilience', 'fake.scenario', 'process.stdout.write("LEAF RAN\\n")');
  // Port 9 (discard) has no listener on loopback.
  const result = run(dir, 'resilience', 'fake.scenario', { SDKHARNESS_SIMULATOR_CONTROL_URL: 'http://127.0.0.1:9' });
  assert.equal(result.outcome, 'FAIL');
  assert.equal(result.detail, 'configuration: cannot read the simulator journal');
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes('LEAF RAN'));
});

test('health-golden-path: refuses [::1], a non-fixed credential, and a missing credential before any build', () => {
  const script = path.join(TESTS, 'health-golden-path');
  const good = {
    PATH: process.env.PATH,
    SDKHARNESS_TEST_LEVEL: 'health',
    SDKHARNESS_SCENARIO: 'golden-path',
    SDKHARNESS_SIMULATOR_URL: 'http://127.0.0.1:9',
    HEALTHCHECK_REALM_URL: 'http://127.0.0.1:9',
    B2_TEST_APPLICATION_KEY_ID: 'test-key-id',
    B2_TEST_APPLICATION_KEY: 'test-key',
    B2_BUCKET_NAME: 'b',
  };
  const cases = [
    [{ SDKHARNESS_SIMULATOR_URL: 'http://[::1]:9', HEALTHCHECK_REALM_URL: 'http://[::1]:9' }, /127\.0\.0\.1/],
    [{ SDKHARNESS_SIMULATOR_URL: 'https://example.com', HEALTHCHECK_REALM_URL: 'https://example.com' }, /127\.0\.0\.1/],
    [{ B2_TEST_APPLICATION_KEY_ID: 'K0051234567890abcdef', B2_TEST_APPLICATION_KEY: 'real-looking-secret' }, /only the fixed simulator credential/],
    [{ B2_TEST_APPLICATION_KEY_ID: '', B2_TEST_APPLICATION_KEY: '' }, /only the fixed simulator credential/],
    [{ HEALTHCHECK_REALM_URL: 'http://127.0.0.1:10' }, /differs/],
  ];
  for (const [override, pattern] of cases) {
    const result = spawnSync(script, [], {
      // cwd without a package.json: reaching `pnpm build` would fail differently
      cwd: os.tmpdir(),
      env: { ...good, ...override },
      encoding: 'utf8',
    });
    const line = result.stdout.split('\n').find((l) => l.startsWith('SDKHARNESS_RESULT')) || '';
    const fields = line.split('\t');
    assert.equal(fields[3], 'FAIL', result.stdout + result.stderr);
    assert.equal(result.status, 65);
    assert.match(fields[4], pattern);
    assert.ok(!/real-looking-secret|K0051234567890abcdef/.test(result.stdout + result.stderr));
  }
});
