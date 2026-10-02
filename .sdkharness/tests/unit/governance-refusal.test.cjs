'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const { isGovernanceRefusal } = require(path.join(root, 'lib', 'governance-refusal.cjs'));

function b2Error(status, code, message = 'x') {
  return Object.assign(new Error(message), { name: 'B2Error', status, code });
}

test('a 401 access_denied is the governance refusal', () => {
  assert.equal(isGovernanceRefusal(b2Error(401, 'access_denied', 'Access Denied')), true);
});

test('a message that names governance retention is still the governance refusal', () => {
  assert.equal(
    isGovernanceRefusal(b2Error(400, 'file_lock_governance_protected', 'Governance retention')),
    true,
  );
});

test('an unrelated refusal is not the governance refusal', () => {
  for (const error of [
    b2Error(401, 'bad_auth_token'),
    b2Error(401, 'expired_auth_token'),
    b2Error(403, 'access_denied'),
    b2Error(404, 'file_not_present'),
    b2Error(503, 'service_unavailable'),
    new TypeError('fetch failed'),
    null,
    undefined,
  ]) {
    assert.equal(isGovernanceRefusal(error), false, String(error?.message));
  }
});

test('lock.bypass_governance uses the shared refusal rule', () => {
  const leaf = readFileSync(path.join(root, 'conformance', 'lock.bypass_governance.cjs'), 'utf8');
  assert.match(leaf, /isGovernanceRefusal\(refusal\)/);
  assert.match(leaf, /confirm the refused delete removed nothing/);
});
