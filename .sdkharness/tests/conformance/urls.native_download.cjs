#!/usr/bin/env node
/*
 * b2-sdk-typescript x urls.native_download -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a fixture object
 *   Action  get a download authorization for a prefix with a short TTL, fetch
 *           it, then move past the expiry
 *   Assert  200 with the correct bytes, then 401; the URL must carry the
 *           B2-NATIVE share token, not a SigV4 query string
 *
 * DOCS. The expected values are B2's published NATIVE contract, not SigV4.
 * b2_get_download_authorization "Returns an authorization token that can be
 * passed to b2_download_file_by_name in the Authorization header or as an
 * Authorization parameter", limited to fileNamePrefix and expiring after
 * validDurationInSeconds. b2_download_file_by_name addresses
 * <downloadUrl>/file/<bucket>/<name>, accepts the token "in the URL query string
 * instead of being passed in the HTTP header", and answers an expired one with
 * 401 expired_auth_token.
 * https://www.backblaze.com/apidocs/b2-get-download-authorization
 * https://www.backblaze.com/apidocs/b2-download-file-by-name
 * The assertion below matches: /file/<bucket>/<name>, ?Authorization=<the
 * issued token>, no X-Amz-* parameter, 401 after expiry.
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
 * HOST -- why this check alone addresses sdkharness-loopback-fixture.backblaze.net.
 * The SDK builds a native share URL only when downloadUrl's host ends in a
 * Backblaze suffix (dist/s3/index.js:11-16, :289), and the simulator reports
 * as downloadUrl the origin the client addressed, so 127.0.0.1 can never
 * pass. This is the same arrangement the pre-relocation in-process check
 * relied on: with no realm option the SDK built requests for
 * https://api.backblazeb2.com (dist/client.js:51), and SimulatorTransport
 * echoed that origin back as downloadUrl (dist/simulator/index.js:3421)
 * without opening a socket. The SDK believed the Backblaze hostname then as
 * now; only delivery was redirected. Here that happens on the network: the
 * realm names bin/simulator/fixture-host.cjs's FIXTURE_HOST, which exists in
 * no DNS and resolves to 127.0.0.1 only in this process (a dns.lookup patch),
 * loopback-cert.pem carries it as a SAN so TLS verification stays on, and
 * serve.mjs echoes it back. No other check addresses that name.
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API was taken
 * from docs/sdks/b2-sdk-typescript/card.md (which carries path:line citations)
 * and the package's published types.
 */
'use strict';

const crypto = require('node:crypto');

const SLUG = 'b2-sdk-typescript';
const CAPABILITY = 'urls.native_download';
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

const OBJECT_NAME = 'st/shared.txt';
// B2's documented minimum validDurationInSeconds is 1; the check waits it out
// in real time, because nothing over HTTP can move the realm's clock.
const TTL_SECONDS = 1;

async function run() {
  // The harness simulator always runs strictAuth, which is what makes the
  // download authorization actually enforced: permissive mode serves /file/
  // regardless of the token.
  // Over TLS, on the fixture host: see HOST above.
const { FIXTURE_HOST, routeFixtureHostToLoopback } = require('../lib/fixture-host.cjs');
  const realm = new URL(simulatorHttpsRealm());
  realm.hostname = FIXTURE_HOST;
  routeFixtureHostToLoopback();
  const { client } = await simulatorClient({ realm: realm.origin });
  const { BufferSource } = await load();
  const s3 = await load('s3');

  const payload = Buffer.from('bytes behind a native download authorization');
  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    await step('fixture', () =>
      bucket.upload({ fileName: OBJECT_NAME, source: new BufferSource(payload) }));

    const authorization = await step('get download authorization', () =>
      bucket.getDownloadAuthorization('st/', TTL_SECONDS));
    neverPrint(authorization.authorizationToken);
    if (authorization.fileNamePrefix !== 'st/') {
      throw new Failure('get download authorization', 'the authorization is scoped to a different prefix');
    }

    const url = await step('build the share URL', () => s3.createNativeDownloadAuthorizationUrl(
      client.accountInfo.getDownloadUrl(),
      bucket.name,
      OBJECT_NAME,
      authorization.authorizationToken,
      TTL_SECONDS,
    ));

    // Shape first: this must be the B2-native share token, not SigV4.
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/file/' + bucket.name + '/')) {
      throw new Failure('share URL shape', 'the URL is not a native /file/<bucket>/<name> URL');
    }
    if (!parsed.searchParams.has('Authorization')) {
      throw new Failure('share URL shape', 'the URL carries no Authorization query parameter');
    }
    if (parsed.searchParams.get('Authorization') !== authorization.authorizationToken) {
      throw new Failure('share URL shape', 'the URL does not carry the issued share token');
    }
    for (const name of parsed.searchParams.keys()) {
      if (name.toLowerCase().startsWith('x-amz-')) {
        throw new Failure('share URL shape',
          'the native share URL carries a SigV4 parameter (' + name + ')');
      }
    }

    // A share URL is fetched the way its recipient would: a plain GET.
    const ok = await step('fetch the share URL', () => fetch(url));
    if (ok.status !== 200) {
      throw new Failure('fetch the share URL', 'the share URL returned ' + ok.status + ', expected 200');
    }
    const got = await step('fetch the share URL', () => readAll(ok.body));
    if (!got.equals(payload)) {
      throw new Failure('fetch the share URL', 'the share URL returned the wrong bytes');
    }

    // Past the TTL, in real time.
    await new Promise((resolve) => setTimeout(resolve, (TTL_SECONDS + 1) * 1000));
    const expired = await step('fetch after expiry', () => fetch(url));
    if (expired.status !== 401) {
      throw new Failure('fetch after expiry',
        'the expired share URL returned ' + expired.status + ', expected 401');
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
