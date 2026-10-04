#!/usr/bin/env node
/*
 * b2-sdk-typescript x enc.sse_c -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a 32-byte customer key
 *   Action  upload with SSE-C; download with the key; download without it
 *   Assert  the upload reports SSE-C mode and the key md5; the with-key
 *           download returns plaintext; the without-key download fails
 *
 * The expected value is B2's published contract. b2_upload_file takes the
 * X-Bz-Server-Side-Encryption-Customer-Algorithm (AES256), -Customer-Key and
 * -Customer-Key-Md5 headers; its response serverSideEncryption carries "the mode
 * ("SSE-B2" or "SSE-C") and algorithm" -- no key md5.
 * https://www.backblaze.com/apidocs/b2-upload-file
 * The key md5 comes back on download: X-Bz-Server-Side-Encryption-Customer-Key-Md5
 * "if the file was encrypted with SSE-C, then the value is the MD5 digest of the
 * customer-managed encryption key used for encryption".
 * https://www.backblaze.com/apidocs/b2-download-file-by-id
 * Without the key: "Backblaze B2 manages the encryption process using the key
 * that you provide when uploading or accessing each file"; the docs name an
 * error only for the WRONG key -- "a 403 error is returned" -- not for no key.
 * https://www.backblaze.com/docs/cloud-storage-server-side-encryption
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

const SLUG = 'b2-sdk-typescript';
const CAPABILITY = 'enc.sse_c';
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
const guard = require('../lib/guard.cjs');

// Proxy variables must not reroute a loopback request.
guard.scrubProxyEnv();

const SIM_KEY_ID = guard.FIXED_KEY_ID;
const SIM_KEY = guard.FIXED_KEY;
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
  let text = value instanceof Error ? guard.describeError(value) : String(value);
  for (const secret of SECRETS) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 400);
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

/**
 * Import this checkout's built SDK. Only a missing build is amber; a built SDK
 * that throws on import is a FAIL (an SDK regression, not an unanswerable question).
 */
async function load(subpath) {
  const specifier = subpath ? `@backblaze-labs/b2-sdk/${subpath}` : '@backblaze-labs/b2-sdk';
  return guard.importBuiltSdk(specifier, {
    missing: (detail) => new Amber('missing-runtime', detail),
    broken: (detail) => new Failure('import', detail),
  });
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
  const realm = guard.originFromEnv('CONFORMANCE_SIMULATOR_URL',
    (message) => new Failure('configuration', message));
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

const OBJECT_NAME = 'st/sse-c.txt';

async function run() {
  const { client } = await simulatorClient();
  const { BufferSource, EncryptionKey } = await load();

  // A fixed 32-byte key: reproducible, and never printed.
  const key = await step('derive customer key', () =>
    EncryptionKey.fromBytes(new Uint8Array(32).fill(7)));
  neverPrint(key.customerKey);
  if (key.mode !== 'SSE-C' || key.algorithm !== 'AES256') {
    throw new Failure('derive customer key', 'the key is not an AES256 SSE-C setting');
  }

  const payload = Buffer.from('customer-encrypted plaintext');
  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    const uploaded = await step('upload with SSE-C', () => bucket.upload({
      fileName: OBJECT_NAME,
      source: new BufferSource(payload),
      serverSideEncryption: key,
    }));
    const reported = uploaded.serverSideEncryption;
    if (!reported || reported.mode !== 'SSE-C' || reported.algorithm !== 'AES256') {
      throw new Failure('upload with SSE-C',
        'the upload reported encryption ' + JSON.stringify(reported) + ', expected SSE-C/AES256');
    }

    const head = await step('read back key md5', () =>
      bucket.head(OBJECT_NAME, { serverSideEncryption: key }));
    const onRead = head.headers.serverSideEncryption;
    if (!onRead || onRead.mode !== 'SSE-C') {
      throw new Failure('read back key md5',
        'metadata reports encryption ' + JSON.stringify(onRead) + ', expected SSE-C');
    }
    if (onRead.customerKeyMd5 !== key.customerKeyMd5) {
      throw new Failure('read back key md5', 'the reported customer key md5 is not the key we sent');
    }

    const download = await step('download with the key', () =>
      bucket.download(OBJECT_NAME, { serverSideEncryption: key }));
    const got = await step('download with the key', () => readAll(download.body));
    if (!got.equals(payload)) {
      throw new Failure('download with the key', 'the SSE-C download did not return the plaintext');
    }

    // The refusal must be the SDK's typed answer to a missing customer key
    // (HTTP 400 bad_request naming the customer encryption headers), not any
    // error at all: a network blip or a TypeError is not a refusal.
    const refusal = await guard.capture(async () => {
      const blind = await bucket.download(OBJECT_NAME);
      await readAll(blind.body);
    });
    if (!refusal) {
      throw new Failure('download without the key',
        'an SSE-C object was readable without presenting the customer key');
    }
    const wrong = guard.explainMismatch(refusal, {
      names: ['BadRequestError'],
      statuses: [400],
      codes: ['bad_request'],
      message: /customer|SSE-C|encryption/i,
    });
    if (wrong) {
      throw new Failure('download without the key', 'refused for the wrong reason: ' + wrong);
    }

    note('the upload response carries the SSE-C mode only; the customer key md5 is asserted on the '
      + 'head path, which is where this SDK surfaces it.');
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
