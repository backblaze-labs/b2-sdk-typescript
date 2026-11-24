'use strict';

/*
 * Does this error count as the refusal of a delete (or retention change) of a
 * version under governance retention, made without bypassGovernance?
 *
 * Two shapes count:
 *   - the message names governance retention (the TypeScript SDK's own
 *     simulator profile answers 400 file_lock_governance_protected), or
 *   - HTTP 401 with code `access_denied`. B2's published contract for
 *     b2_delete_file_version is "401 access_denied, The delete was not allowed
 *     because Object Lock is enabled on the file", and the Python SDK's
 *     raw-API contract test (test/integration/test_raw_api.py, a delete without
 *     bypass on a governance-locked version raises Unauthorized, then the
 *     bypassing delete succeeds) passes against real B2 with it. The exact code
 *     and message are NOT verified against real B2 (UNVERIFIED in the
 *     b2-simulator ledger, docs/FIDELITY.md).
 *
 * Anything else is NOT a refusal for this reason: a bad or expired token
 * (401 bad_auth_token / expired_auth_token), a 5xx, a 404, a network error.
 */
function isGovernanceRefusal(error) {
  if (!error) return false;
  if (/governance/i.test(String(error.message))) return true;
  return error.status === 401 && error.code === 'access_denied';
}

module.exports = { isGovernanceRefusal };
