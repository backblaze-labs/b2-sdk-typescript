'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const { isLegalHoldRefusal } = require(path.join(root, 'lib', 'legal-hold-refusal.cjs'));

function b2Error(status, code, message = 'x') {
  return Object.assign(new Error(message), { name: 'B2Error', status, code });
}

test('a 401 access_denied is the legal-hold refusal (what real B2 answers)', () => {
  assert.equal(isLegalHoldRefusal(b2Error(401, 'access_denied', 'Access Denied')), true);
});

test('the TypeScript SDK simulator profile refusals are still the legal-hold refusal', () => {
  assert.equal(
    isLegalHoldRefusal(b2Error(400, 'file_lock_legal_hold_protected', 'Legal hold is on')),
    true,
  );
  assert.equal(
    isLegalHoldRefusal(b2Error(403, 'file_lock_legal_hold_protected', 'Legal hold is on')),
    true,
  );
});

test('an unrelated refusal is not the legal-hold refusal', () => {
  for (const error of [
    b2Error(401, 'bad_auth_token'),
    b2Error(401, 'expired_auth_token'),
    b2Error(403, 'access_denied'),
    b2Error(400, 'bad_request'),
    b2Error(404, 'file_not_present'),
    b2Error(503, 'service_unavailable'),
    new TypeError('fetch failed'),
    null,
    undefined,
  ]) {
    assert.equal(isLegalHoldRefusal(error), false, String(error?.message));
  }
});

test('lock.legal_hold uses the shared refusal rule', () => {
  const leaf = readFileSync(path.join(root, 'conformance', 'lock.legal_hold.cjs'), 'utf8');
  assert.match(leaf, /isLegalHoldRefusal\(refusal\)/);
  assert.match(leaf, /refused for the wrong reason/);
});
