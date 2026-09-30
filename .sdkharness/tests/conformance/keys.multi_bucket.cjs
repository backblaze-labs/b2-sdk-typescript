#!/usr/bin/env node
/*
 * b2-sdk-typescript x keys.multi_bucket -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   three buckets
 *   Action  create a key scoped to two bucketIds and authorize with it
 *   Assert  the read-back lists both ids; the key can reach both buckets and
 *           is refused on the third
 *
 * DOCS. The expected values are B2's published contract. b2_create_key's
 * bucketIds: "When provided, the new key can only access the specified
 * buckets", echoed in its response; the v4 API (April 24, 2025) removed the
 * singular bucketId for it. v4 b2_authorize_account reports the scope as
 * allowed.buckets. A restricted token that asks b2_list_buckets for another
 * bucket "will be denied" -- documented as 401 unauthorized.
 * https://www.backblaze.com/apidocs/b2-create-key
 * https://www.backblaze.com/apidocs/b2-authorize-account
 * https://www.backblaze.com/apidocs/b2-list-buckets
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
const CAPABILITY = 'keys.multi_bucket';
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

const KEY_NAME = 'sdkharness-conf-multibucket';

async function run() {
  // The harness simulator always runs strictAuth, which is what makes the third
  // bucket actually refuse: permissive mode never enforces a key's bucket scope.
  const { client, realm } = await simulatorClient();
  const { B2Client } = await load();
  const { BufferSource } = await load();

  const buckets = [];
  let created = null;

  try {
    for (let i = 0; i < 3; i += 1) {
      buckets.push(await step('create buckets', () =>
        client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' })));
    }
    for (const bucket of buckets) {
      await step('fixtures', () =>
        bucket.upload({ fileName: 'st/x.txt', source: new BufferSource(Buffer.from(bucket.name)) }));
    }

    const scoped = [buckets[0].id, buckets[1].id];
    created = await step('create scoped key', () => client.createKey({
      keyName: KEY_NAME,
      capabilities: ['listBuckets', 'listFiles', 'readFiles'],
      bucketIds: scoped,
    }));
    neverPrint(created.applicationKey);

    const readBack = (created.bucketIds || []).slice().sort().join(',');
    if (readBack !== scoped.slice().sort().join(',')) {
      throw new Failure('create scoped key',
        'the key reports bucketIds ' + readBack + ', expected both scoped ids');
    }

    const restricted = new B2Client({
      applicationKeyId: created.applicationKeyId,
      applicationKey: created.applicationKey,
      realm,
      allowedHostSuffixes: [],
      userAgent: 'sdkharness-conformance',
    });
    await step('authorize with the scoped key', () => restricted.authorize());

    const allowed = restricted.accountInfo.getAllowedBucketIds
      ? restricted.accountInfo.getAllowedBucketIds() : null;
    if (!allowed || allowed.slice().sort().join(',') !== scoped.slice().sort().join(',')) {
      throw new Failure('authorize with the scoped key',
        'the authorization reports allowed buckets ' + JSON.stringify(allowed));
    }

    for (const bucket of buckets.slice(0, 2)) {
      const reachable = await step('reach the scoped buckets', () => restricted.getBucket(bucket.name));
      if (!reachable) {
        throw new Failure('reach the scoped buckets', bucket.name + ' was not reachable by the scoped key');
      }
      const listing = await step('reach the scoped buckets', () =>
        reachable.listFileNames({ prefix: 'st/' }));
      if (listing.files.length !== 1) {
        throw new Failure('reach the scoped buckets',
          bucket.name + ' listed ' + listing.files.length + ' files, expected 1');
      }
    }

    let refused = false;
    try {
      const third = await restricted.getBucket(buckets[2].name);
      if (third) await third.listFileNames({ prefix: 'st/' });
    } catch {
      refused = true;
    }
    if (!refused) {
      throw new Failure('refuse the third bucket',
        'the key reached a bucket outside its two-bucket scope');
    }
  } finally {
    if (created) {
      try {
        await client.deleteKey(created.applicationKeyId);
      } catch {
        /* best effort */
      }
    }
    for (const bucket of buckets) await destroy(bucket);
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
