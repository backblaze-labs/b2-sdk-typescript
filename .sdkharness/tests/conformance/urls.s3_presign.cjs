#!/usr/bin/env node
/*
 * b2-sdk-typescript x urls.s3_presign -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Action  presign a GET and a PUT
 *   Assert  the URL carries a well-formed SigV4 canonical string /
 *           X-Amz-Signature
 *
 *   SIGNING CHECK ONLY. No S3 data plane exists in this fleet and the
 *   simulator models no S3 endpoint, so no round-trip is attempted and none is
 *   faked.
 *
 * DOCS. The expected values are the contract Backblaze adopts, not one it
 * writes: its S3-compatible API "supports only v4 signatures for
 * authentication" and points at AWS's SigV4 reference. That reference fixes
 * X-Amz-Algorithm=AWS4-HMAC-SHA256, the scope
 * <key>/YYYYMMDD/<region>/<service>/aws4_request, a signed host header, and a
 * lowercase-hex HMAC-SHA256 signature (64 hex); X-Amz-Expires is from AWS's
 * S3 query-string auth page.
 * https://www.backblaze.com/apidocs/introduction-to-the-s3-compatible-api
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
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
const CAPABILITY = 'urls.s3_presign';
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

/**
 * The same simulator over TLS, for the calls the SDK refuses on plain http
 * (dist/s3/index.js:285, dist/s3/sigv4.js:102). The SDK has no CA option --
 * FetchTransport sends through the global fetch (http/transport.d.ts:66-94) --
 * so the runner-named self-signed test cert is pinned as this process's ONLY
 * trusted CA. Verification stays on; nothing else is trusted.
 */
function simulatorHttpsRealm() {
  const realm = process.env.CONFORMANCE_SIMULATOR_HTTPS_URL;
  const ca = process.env.CONFORMANCE_SIMULATOR_CA;
  if (!realm || !ca) {
    throw new Amber('no-realm-option',
      'CONFORMANCE_SIMULATOR_HTTPS_URL / _CA are unset -- this slug runs only under bin/run-conformance.sh --target simulator');
  }
  const tls = require('node:tls');
  if (typeof tls.setDefaultCACertificates !== 'function') {
    throw new Amber('missing-runtime', 'pinning the simulator cert needs node >= 22.19 (tls.setDefaultCACertificates)');
  }
  tls.setDefaultCACertificates([require('node:fs').readFileSync(ca, 'utf8')]);
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

const OBJECT_NAME = 'st/presigned.txt';
const REGION = 'us-west-004';
const EXPIRES_IN = 300;

function assertSigV4(kind, url, expectedPath) {
  const parsed = new URL(url);
  if (parsed.pathname !== expectedPath) {
    throw new Failure(kind, 'the presigned path is not the path-style bucket/key path');
  }
  const query = parsed.searchParams;
  if (query.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') {
    throw new Failure(kind, 'X-Amz-Algorithm is ' + query.get('X-Amz-Algorithm'));
  }
  const credential = query.get('X-Amz-Credential');
  if (!credential) throw new Failure(kind, 'the URL carries no X-Amz-Credential');
  const scope = credential.split('/');
  if (scope.length !== 5 || scope[2] !== REGION || scope[3] !== 's3' || scope[4] !== 'aws4_request') {
    throw new Failure(kind, 'the credential scope is not <key>/<date>/' + REGION + '/s3/aws4_request');
  }
  if (!/^[0-9]{8}$/.test(scope[1])) {
    throw new Failure(kind, 'the credential scope carries no yyyymmdd date');
  }
  const date = query.get('X-Amz-Date');
  if (!date || !/^[0-9]{8}T[0-9]{6}Z$/.test(date)) {
    throw new Failure(kind, 'X-Amz-Date is not an ISO8601 basic timestamp');
  }
  if (date.slice(0, 8) !== scope[1]) {
    throw new Failure(kind, 'X-Amz-Date and the credential scope date disagree');
  }
  if (query.get('X-Amz-Expires') !== String(EXPIRES_IN)) {
    throw new Failure(kind, 'X-Amz-Expires is ' + query.get('X-Amz-Expires'));
  }
  const signed = (query.get('X-Amz-SignedHeaders') || '').split(';');
  if (!signed.includes('host')) {
    throw new Failure(kind, 'X-Amz-SignedHeaders does not sign host');
  }
  const signature = query.get('X-Amz-Signature');
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new Failure(kind, 'X-Amz-Signature is not a 64-hex HMAC-SHA256 digest');
  }
}

async function run() {
  // Over TLS: the SDK presigns only on an https s3ApiUrl.
  const { client } = await simulatorClient({ realm: simulatorHttpsRealm() });
  const s3 = await load('s3');

  for (const name of ['presignS3GetObjectUrl', 'presignS3PutObjectUrl']) {
    if (typeof s3[name] !== 'function') {
      throw new Failure('setup', 'the /s3 subpath exports no ' + name);
    }
  }

  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    // The simulator's authorize response reports its own origin as the S3 API
    // URL, from which no B2 region can be derived, so the region is explicit.
    const common = {
      accountInfo: client.accountInfo,
      applicationKeyId: SIM_KEY_ID,
      applicationKey: SIM_KEY,
      region: REGION,
      bucketName: bucket.name,
      fileName: OBJECT_NAME,
      expiresIn: EXPIRES_IN,
    };
    const expectedPath = '/' + bucket.name + '/' + OBJECT_NAME;

    const get = await step('presign GET', () => s3.presignS3GetObjectUrl(common));
    // The signature and the key id both live in the URL; it is never printed.
    neverPrint(get);
    assertSigV4('presign GET', get, expectedPath);

    const put = await step('presign PUT', () => s3.presignS3PutObjectUrl(common));
    neverPrint(put);
    assertSigV4('presign PUT', put, expectedPath);

    if (get === put) {
      throw new Failure('presign PUT', 'the GET and PUT presigns produced the same URL');
    }

    note('signing check only: this asserts the SigV4 canonical query the SDK produces. No S3 data '
      + 'plane exists in the fleet and the simulator models no S3 endpoint, so no round-trip was '
      + 'attempted -- a PASS here says the URL is well formed, not that B2 S3 would honour it.');
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
