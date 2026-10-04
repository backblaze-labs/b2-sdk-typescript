'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const guard = require('../lib/guard.cjs');

test('loopback origin: accepts only http://127.0.0.1:<port>', () => {
  assert.equal(guard.requireLoopbackOrigin('http://127.0.0.1:8080', 'X'), 'http://127.0.0.1:8080');
  assert.equal(guard.requireLoopbackOrigin('http://127.0.0.1:8080/', 'X'), 'http://127.0.0.1:8080');
  assert.equal(
    guard.requireLoopbackOrigin('https://127.0.0.1:9443', 'X', { scheme: 'https' }),
    'https://127.0.0.1:9443',
  );
});

for (const bad of [
  'http://[::1]:8080',
  'http://localhost:8080',
  'http://127.0.0.2:8080',
  'http://0.0.0.0:8080',
  'https://127.0.0.1:8080',
  'https://api.backblazeb2.com',
  'https://nonexistent.invalid',
  'http://127.0.0.1',
  'http://127.0.0.1:0',
  'http://127.0.0.1:65536',
  'http://127.0.0.1:80a',
  'http://127.0.0.1:8080/path',
  'http://127.0.0.1:8080/?q=1',
  'http://user:secret@127.0.0.1:8080',
  ' http://127.0.0.1:8080',
  '',
  undefined,
  null,
  42,
]) {
  test(`loopback origin: rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => guard.requireLoopbackOrigin(bad, 'X'), guard.GuardError);
  });
}

test('loopback origin: https scheme rejects the http listener and [::1]', () => {
  assert.throws(
    () => guard.requireLoopbackOrigin('http://127.0.0.1:1', 'X', { scheme: 'https' }),
    guard.GuardError,
  );
  assert.throws(
    () => guard.requireLoopbackOrigin('https://[::1]:1', 'X', { scheme: 'https' }),
    guard.GuardError,
  );
});

test('loopback origin: the message names the variable and never echoes userinfo', () => {
  assert.throws(
    () => guard.requireLoopbackOrigin('http://user:hunter2@example.com:80', 'MY_URL'),
    (error) => /MY_URL/.test(error.message) && !/hunter2|user/.test(error.message),
  );
});

test('originFromEnv: unset stays undefined, bad value becomes the caller error', () => {
  const onInvalid = (message) => new Error(`wrapped ${message}`);
  assert.equal(guard.originFromEnv('X', onInvalid, undefined, {}), undefined);
  assert.equal(guard.originFromEnv('X', onInvalid, undefined, { X: '' }), undefined);
  assert.equal(
    guard.originFromEnv('X', onInvalid, undefined, { X: 'http://127.0.0.1:5/' }),
    'http://127.0.0.1:5',
  );
  assert.throws(
    () => guard.originFromEnv('X', onInvalid, undefined, { X: 'http://[::1]:5' }),
    /wrapped X must be http:\/\/127\.0\.0\.1:<port>/,
  );
});

test('fixed credential: only the simulator pair passes', () => {
  guard.requireFixedCredential('test-key-id', 'test-key');
  for (const [id, key] of [
    ['K005abcdefghijklmnopqrstu', '005aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['test-key-id', 'other'],
    ['other', 'test-key'],
    [undefined, undefined],
    ['', ''],
  ]) {
    assert.throws(
      () => guard.requireFixedCredential(id, key),
      (error) =>
        error instanceof guard.GuardError &&
        error.message === 'only the fixed simulator credential is accepted',
    );
  }
});

test('scrubProxyEnv: removes proxy variables in either case and reports names only', () => {
  const env = {
    HTTP_PROXY: 'http://user:pw@proxy:3128',
    https_proxy: 'http://proxy:3128',
    ALL_PROXY: 'socks5://p',
    no_proxy: 'x',
    NODE_USE_ENV_PROXY: '1',
    PATH: '/bin',
  };
  const removed = guard.scrubProxyEnv(env);
  assert.deepEqual(env, { PATH: '/bin' });
  assert.deepEqual(removed.sort(), ['ALL_PROXY', 'HTTP_PROXY', 'NODE_USE_ENV_PROXY', 'https_proxy', 'no_proxy']);
  assert.ok(!removed.join(' ').includes('pw'));
});

function fakeCheckout({ withDist, exportsMap }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkharness-guard-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: '@backblaze-labs/b2-sdk',
      exports: exportsMap || {
        '.': { import: { default: './dist/index.js' } },
        './s3': { import: { default: './dist/s3/index.js' } },
      },
    }),
  );
  if (withDist) {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export {}');
  }
  return root;
}

const hooks = {
  missing: (detail) => Object.assign(new Error(detail), { verdict: 'amber' }),
  broken: (detail) => Object.assign(new Error(detail), { verdict: 'fail' }),
};

test('importBuiltSdk: a missing build is amber and nothing is imported', async () => {
  const root = fakeCheckout({ withDist: false });
  let called = false;
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk', hooks, {
      root,
      importer: async () => {
        called = true;
      },
    }),
    (error) => error.verdict === 'amber' && /build this exact checkout first/.test(error.message),
  );
  assert.equal(called, false);
});

test('importBuiltSdk: a built SDK that throws on import is a FAIL with the reason', async () => {
  const root = fakeCheckout({ withDist: true });
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk', hooks, {
      root,
      importer: async () => {
        throw new Error('circular import exploded');
      },
    }),
    (error) => error.verdict === 'fail' && /circular import exploded/.test(error.message),
  );
});

test('importBuiltSdk: a module-not-found thrown by SDK code is still a FAIL', async () => {
  const root = fakeCheckout({ withDist: true });
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk', hooks, {
      root,
      importer: async () => {
        throw Object.assign(new Error("Cannot find module './gone.js'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        });
      },
    }),
    (error) => error.verdict === 'fail' && /ERR_MODULE_NOT_FOUND/.test(error.message),
  );
});

test('importBuiltSdk: dist/ present but this exports target file absent is a FAIL, not amber', async () => {
  const root = fakeCheckout({ withDist: true });
  let called = false;
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk/s3', hooks, {
      root,
      importer: async () => {
        called = true;
        return {};
      },
    }),
    (error) => error.verdict === 'fail' && /dist\/s3\/index\.js/.test(error.message),
  );
  assert.equal(called, false);
});

test('importBuiltSdk: a renamed build output (dist/ has other files, not the target) is a FAIL', async () => {
  const root = fakeCheckout({ withDist: true });
  fs.renameSync(path.join(root, 'dist', 'index.js'), path.join(root, 'dist', 'main.js'));
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk', hooks, { root, importer: async () => ({}) }),
    (error) => error.verdict === 'fail',
  );
});

test('importBuiltSdk: only an absent dist/ is amber, even for a subpath', async () => {
  const root = fakeCheckout({ withDist: false });
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk/s3', hooks, { root, importer: async () => ({}) }),
    (error) => error.verdict === 'amber',
  );
});

test('importBuiltSdk: a subpath removed from package.json exports is a FAIL', async () => {
  const root = fakeCheckout({ withDist: true });
  await assert.rejects(
    guard.importBuiltSdk('@backblaze-labs/b2-sdk/not-exported', hooks, { root, importer: async () => ({}) }),
    (error) => error.verdict === 'fail' && /not exported/.test(error.message),
  );
});

test('importBuiltSdk: returns the module when the build is fine', async () => {
  const root = fakeCheckout({ withDist: true });
  const mod = await guard.importBuiltSdk('@backblaze-labs/b2-sdk', hooks, {
    root,
    importer: async () => ({ B2Client: class {} }),
  });
  assert.equal(typeof mod.B2Client, 'function');
});

test('explainMismatch: requires every given field to match', () => {
  const error = Object.assign(new Error('File is on legal hold'), {
    name: 'B2Error',
    status: 400,
    code: 'file_lock_legal_hold_protected',
  });
  const spec = { statuses: [400, 403], codes: ['file_lock_legal_hold_protected'], message: /legal.?hold/i };
  assert.equal(guard.explainMismatch(error, spec), '');
  assert.match(guard.explainMismatch(new TypeError('x is not a function'), spec), /status undefined/);
  assert.match(
    guard.explainMismatch(Object.assign(new Error('timeout'), { name: 'NetworkError' }), spec),
    /unexpected status undefined, code undefined, message: NetworkError/,
  );
  assert.match(guard.explainMismatch(Object.assign(error, { status: 500 }), spec), /status 500/);
  assert.match(guard.explainMismatch('boom', spec), /non-Error/);
  assert.match(
    guard.explainMismatch(Object.assign(new Error('m'), { name: 'Other' }), { names: ['BadRequestError'] }),
    /type Other/,
  );
});

test('capture: returns the thrown error, or null when nothing throws', async () => {
  const boom = new Error('boom');
  assert.equal(await guard.capture(async () => { throw boom; }), boom);
  assert.equal(await guard.capture(async () => 1), null);
});

test('describeError: carries the cause chain', () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
  const wrapped = Object.assign(new Error(''), { name: 'NetworkError', cause });
  assert.equal(
    guard.describeError(wrapped),
    'NetworkError <- Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:1',
  );
});

// requireFreshSimulator: the resilience dispatcher's stale-journal refusal.
function journalServer(handler) {
  return new Promise((resolve) => {
    const server = require('node:http').createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
const reply = (body, status = 200) => (_req, res) => {
  res.statusCode = status;
  res.end(body);
};

test('fresh journal: an empty journal passes through', async () => {
  const { server, url } = await journalServer(reply('{"entries":[]}'));
  try {
    await guard.requireFreshSimulator(url);
  } finally {
    server.close();
  }
});

test('fresh journal: a non-empty journal is refused with the served count', async () => {
  const { server, url } = await journalServer(reply('{"entries":[{"seq":1},{"seq":2}]}'));
  try {
    await assert.rejects(
      guard.requireFreshSimulator(url),
      (error) => error instanceof guard.GuardError && /already served 2 request\(s\)/.test(error.message),
    );
  } finally {
    server.close();
  }
});

for (const [name, body, status] of [
  ['malformed JSON', 'not json', 200],
  ['no entries array', '{"entries":3}', 200],
  ['an error status', '{"entries":[]}', 500],
]) {
  test(`fresh journal: ${name} is refused as unreadable`, async () => {
    const { server, url } = await journalServer(reply(body, status));
    try {
      await assert.rejects(guard.requireFreshSimulator(url), /cannot read the simulator journal/);
    } finally {
      server.close();
    }
  });
}

test('fresh journal: an unreachable simulator is refused as unreadable', async () => {
  await assert.rejects(guard.requireFreshSimulator('http://127.0.0.1:1'), /cannot read the simulator journal/);
});

test('fresh journal: a hung simulator times out as unreadable', async () => {
  const { server, url } = await journalServer(() => {});
  try {
    await assert.rejects(
      guard.requireFreshSimulator(url, { timeoutMs: 100 }),
      /cannot read the simulator journal/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('fresh journal: a non-loopback control URL is refused by the loopback guard', async () => {
  await assert.rejects(guard.requireFreshSimulator('https://api.backblazeb2.com'), guard.GuardError);
});
