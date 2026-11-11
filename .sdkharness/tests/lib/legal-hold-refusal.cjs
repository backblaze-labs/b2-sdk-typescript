'use strict';

/*
 * Does this error count as the refusal of a delete of a version under a legal
 * hold?
 *
 * Two shapes count:
 *   - HTTP 401 with code `access_denied` ("Access Denied"). This is what real
 *     B2 answers for b2_delete_file_version on a version under a legal hold,
 *     measured against real B2 on 2026-11-10 (b2-simulator ledger F-139), and
 *     what the simulator's b2 profile now answers too.
 *   - HTTP 400 or 403 with code `file_lock_legal_hold_protected` whose message names the legal
 *     hold, the
 *     TypeScript SDK's own simulator profile (not what real B2 answers). Kept
 *     so the check still passes against that profile and older simulator pins.
 *
 * Anything else is NOT a refusal for this reason: a bad or expired token
 * (401 bad_auth_token / expired_auth_token), a 403 access_denied, a 404, a 5xx,
 * a network error.
 */
function isLegalHoldRefusal(error) {
  if (!error) return false;
  if (error.status === 401 && error.code === 'access_denied') return true;
  return (
    (error.status === 400 || error.status === 403) &&
    error.code === 'file_lock_legal_hold_protected' &&
    /legal.?hold/i.test(String(error.message))
  );
}

module.exports = { isLegalHoldRefusal };
