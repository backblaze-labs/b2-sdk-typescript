#!/usr/bin/env node
/*
 * b2-sdk-typescript x lock.bypass_governance -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   an object under governance retention and a key holding the
 *           bypass capability
 *   Action  delete without bypass, then with it
 *   Assert  the first fails with the expected error, the second succeeds, and
 *           the version is gone
 *
 * The expected value is B2's published contract. b2_delete_file_version's
 * bypassGovernance "Must be specified and set to true if deleting a file version
 * protected by Object Lock governance mode retention settings. Setting the value
 * requires the bypassGovernance application key capability." Without it the
 * delete is refused: 401 access_denied, "The delete was not allowed because
 * Object Lock is enabled on the file."
 * https://www.backblaze.com/apidocs/b2-delete-file-version
 *
 * 401 access_denied is accepted as the refusal (lib/governance-refusal.cjs):
 * the Python SDK's raw-API contract test for this exact call passes against
 * real B2 with a 401, and the standalone simulator's default profile answers
 * the same. A bad or expired token, a 5xx, a 404 or a network error is not a
 * refusal for this reason. The exact code and message are not verified against
 * real B2.
 *
 * TARGET -- why this slug always says @simulator.
 * b2-sdk-typescript does not target a B2 realm from this harness. Every check
 * here drives the SDK's real HTTP path against the harness's own B2 simulator
 * (bin/simulator/serve.mjs), started fresh for this check by
 * bin/run-conformance.sh --target simulator and named in
 * CONFORMANCE_SIMULATOR_URL. So the line below reports @simulator whatever
 * CONFORMANCE_TARGET asks for, and without that URL it reports
 * no-realm-option. A simulator PASS is WEAKER evidence than a staging PASS: it
 * says the SDK and the harness's simulator agree, not that real B2 agrees.
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API was taken
 * from docs/sdks/b2-sdk-typescript/card.md (which carries path:line citations)
 * and the package's published types.
 */
'use strict';

const crypto = require('node:crypto');

const { isGovernanceRefusal } = require('../lib/governance-refusal.cjs');

const SLUG = 'b2-sdk-typescript';
const CAPABILITY = 'lock.bypass_governance';
// Always the simulator. See TARGET above.
const TARGET = 'simulator';

// The closed reason set, mirrored from bin/conformance/README.md. The runner
// enforces it; naming one outside this set is a FAIL it manufactures.
const REASONS = new Set([
  'no-realm-option',
  'unreachable',
  'unauthorized',
  'no-credential',
  'missing-runtime',
  'not-claimed',
]);

// The simulator's fixed test credential, which the runner also injects as
// B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY. Not a secret, but the redactor
// keeps it -- and anything else registered below -- out of
// every detail string all the same.
const SIM_KEY_ID = 'test-key-id';
const SIM_KEY = 'test-key';
const SECRETS = [SIM_KEY_ID, SIM_KEY];

/** The question could not be asked. Reason must be in REASONS. */
class Amber extends Error {
  constructor(reason, detail) {
    super(detail);
    if (!REASONS.has(reason)) throw new Error(`reason outside the closed set: ${reason}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/** A golden-path step that did not do what the card claims. */
class Failure extends Error {
  constructor(step, detail) {
    super(detail);
    this.step = step;
    this.detail = detail;
  }
}

/** Register a value that must never reach stdout (a minted key secret, a presigned URL). */
function neverPrint(value) {
  if (typeof value === 'string' && value.length > 0) SECRETS.push(value);
  return value;
}

// A credential NEVER reaches a detail: only an error class and its message,
// with every registered secret substituted out and the whole thing truncated.
function redact(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  for (const secret of SECRETS) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}

/** The one result line. Exactly one, on stdout, at the start of a line. */
function say(verdict) {
  process.stdout.write(`CONFORMANCE ${SLUG} ${CAPABILITY} @${TARGET}: ${verdict}\n`);
}

// Weak or narrowed evidence is said here, not in the verdict: the runner
// accepts a bare PASS only, so a "PASS (detail)" would read as unparseable.
// These lines are kept by SDKHARNESS_FULL_LOG_DIR.
function note(text) {
  process.stdout.write(`note: ${text}\n`);
}

// One golden-path step. Anything the environment throws that is not already a
// verdict becomes a Failure naming the step -- never a stack trace, never a body.
async function step(name, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Amber || error instanceof Failure) throw error;
    throw new Failure(name, redact(error));
  }
}

/** Import one subpath of this checkout. An absent package is amber. */
async function load(subpath) {
  const specifier = subpath ? `@backblaze-labs/b2-sdk/${subpath}` : '@backblaze-labs/b2-sdk';
  try {
    return await import(specifier);
  } catch (error) {
    throw new Amber('missing-runtime', `${specifier} is unavailable -- build this exact checkout first`);
  }
}

/**
 * A B2Client on the SDK's DEFAULT fetch transport, pointed over loopback HTTP
 * at the harness's own simulator (bin/simulator/serve.mjs), which the runner
 * starts fresh for this check and names in CONFORMANCE_SIMULATOR_URL. Options
 * go to B2ClientOptions. `wrap` may interpose an instrumenting transport
 * around a plain FetchTransport.
 *
 * The SSRF guard is off either way (`allowedHostSuffixes: []`, the SDK's
 * documented test-setup switch, client.d.ts:48-58): the SDK accepts a
 * plaintext realm only on a loopback IP (auth/realms.js), yet its guard
 * rejects every literal IP after authorize (http/url-guard.js:83), so no
 * loopback realm is reachable with it on.
 */
async function simulatorClient(options = {}) {
  const { wrap, ...clientOptions } = options;
  const realm = simulatorRealm();
  const { B2Client, FetchTransport } = await load();
  const transport = wrap ? wrap(new FetchTransport({ userAgent: 'sdkharness-conformance' })) : undefined;
  const client = new B2Client({
    applicationKeyId: SIM_KEY_ID,
    applicationKey: SIM_KEY,
    realm,
    userAgent: 'sdkharness-conformance',
    ...(transport ? { transport } : { allowedHostSuffixes: [] }),
    ...clientOptions,
  });
  await step('authorize', () => client.authorize());
  return { client, transport, realm };
}

/** The harness simulator's URL. Without it this slug has no realm to ask. */
function simulatorRealm() {
  const realm = process.env.CONFORMANCE_SIMULATOR_URL;
  if (!realm) {
    throw new Amber('no-realm-option',
      'CONFORMANCE_SIMULATOR_URL is unset -- this slug runs only under bin/run-conformance.sh --target simulator');
  }
  return realm;
}

/** Ephemeral bucket names are sdkharness-conf-<random>; object keys live under st/. */
function bucketName() {
  return `sdkharness-conf-${crypto.randomBytes(6).toString('hex')}`;
}

/** Collect a WHATWG ReadableStream (the SDK's download body) into a Buffer. */
async function readAll(body) {
  const chunks = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

/** Deterministic filler bytes, so a diff is reproducible. */
function filler(size, seed = 1) {
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + seed * 7) & 0xff;
  return buffer;
}

// Owns what it created, and destroys it on the error path too. Cleanup can
// never mask the verdict, so every failure here is swallowed.
async function destroy(bucket) {
  if (!bucket) return;
  try {
    for await (const version of bucket.paginateFileVersions({})) {
      if (!version || !version.fileId) continue;
      try {
        await bucket.deleteFileVersion(version.fileName, version.fileId, { bypassGovernance: true });
      } catch {
        /* a retained or held version may legitimately refuse; keep going */
      }
    }
    await bucket.delete();
  } catch {
    /* the server is torn down after this check; cleanup is best effort */
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    if (error instanceof Amber) {
      say(`COULD-NOT-RUN (${error.reason} -- ${error.detail})`);
      return 0;
    }
    if (error instanceof Failure) {
      say(`FAIL (${error.step} -- ${error.detail})`);
      return 1;
    }
    say(`FAIL (setup -- ${redact(error)})`);
    return 1;
  }
  say('PASS');
  return 0;
}

const OBJECT_NAME = 'st/bypass.txt';
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function run() {
  const { client } = await simulatorClient();
  const { BufferSource } = await load();

  const bucket = await step('create lock-enabled bucket', () => client.createBucket({
    bucketName: bucketName(),
    bucketType: 'allPrivate',
    fileLockEnabled: true,
  }));

  try {
    const uploaded = await step('fixture', () =>
      bucket.upload({ fileName: OBJECT_NAME, source: new BufferSource(Buffer.from('governed')) }));

    await step('set governance retention', () => bucket.file(OBJECT_NAME)
      .setRetention(uploaded.fileId, {
        mode: 'governance',
        retainUntilTimestamp: Date.now() + TWO_DAYS_MS,
      }));

    let refusal = null;
    try {
      await bucket.deleteFileVersion(OBJECT_NAME, uploaded.fileId);
    } catch (error) {
      refusal = error;
    }
    if (refusal === null) {
      throw new Failure('delete without bypass', 'the governed version was deleted without bypass');
    }
    // The refusal must be about the lock, not any old error: it names
    // governance, or it is B2's 401 access_denied (see lib/governance-refusal.cjs).
    if (!isGovernanceRefusal(refusal)) {
      throw new Failure('delete without bypass',
        'the refusal did not name governance retention: ' + redact(refusal));
    }

    // And the lock must have held: the refused delete removed nothing.
    const survived = await step('confirm the refused delete removed nothing', () =>
      bucket.listFileVersions({ prefix: OBJECT_NAME }));
    if (!survived.files.some((file) => file.fileId === uploaded.fileId)) {
      throw new Failure('delete without bypass',
        'the delete was refused but the governed version is gone');
    }

    await step('delete with bypass', () =>
      bucket.deleteFileVersion(OBJECT_NAME, uploaded.fileId, { bypassGovernance: true }));

    const versions = await step('confirm deletion', () =>
      bucket.listFileVersions({ prefix: OBJECT_NAME }));
    if (versions.files.some((file) => file.fileId === uploaded.fileId)) {
      throw new Failure('confirm deletion', 'the version survived the bypassing delete');
    }
  } finally {
    await destroy(bucket);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    // Never a silent crash: main() already converts every verdict, so landing
    // here means the reporting path itself broke.
    say(`FAIL (harness -- ${redact(error)})`);
    process.exitCode = 1;
  },
);
