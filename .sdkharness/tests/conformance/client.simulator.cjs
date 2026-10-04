#!/usr/bin/env node
/*
 * b2-sdk-typescript x client.simulator -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a scratch project depending only on the PUBLISHED package
 *   Action  import the shipped fake and run a trivial upload / download
 *           against it
 *   Assert  it works with NO network
 *
 *   This is a packaging and consumability check, not a B2 round-trip.
 *
 * NO DOCUMENTED CONTRACT FOUND -- this is SDK-side/ecosystem tooling, not a B2 API contract.
 * Shipping an in-process fake is packaging; no Backblaze doc page covers it. The
 * fake models the same endpoints the API docs describe, but that is the tool's
 * claim, so a PASS here says the tool and its own fake agree, nothing about B2.
 *
 * TARGET -- why this slug always says @simulator.
 * b2-sdk-typescript does not target a B2 realm from this harness. The SDK
 * ships an in-process B2 fake, B2Simulator, as a public subpath
 * (@backblaze-labs/b2-sdk/simulator), and every check here exercises that.
 * So the line below reports @simulator whatever CONFORMANCE_TARGET asks for,
 * the check needs no credential and no network, and it never reports
 * no-credential. A simulator PASS is WEAKER evidence than a staging PASS: it
 * says the SDK and its own fake agree, not that real B2 agrees.
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API was taken
 * from docs/sdks/b2-sdk-typescript/card.md (which carries path:line citations)
 * and the package's published types.
 */
'use strict';

const crypto = require('node:crypto');

const SLUG = 'b2-sdk-typescript';
const CAPABILITY = 'client.simulator';
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

// The simulator's documented implicit full-access credential. Not a secret,
// but the redactor keeps it -- and anything else registered below -- out of
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
 * A B2Client wired to a fresh in-process simulator: no network, no credential.
 * `simulator` are B2SimulatorOptions; anything else goes to B2ClientOptions.
 * `wrap` may interpose an instrumenting transport around the simulator's.
 */
async function simulatorClient(options = {}) {
  const { simulator: simulatorOptions = {}, wrap, ...clientOptions } = options;
  const { B2Simulator } = await load('simulator');
  const { B2Client } = await load();
  const sim = new B2Simulator(simulatorOptions);
  const transport = wrap ? wrap(sim.transport()) : sim.transport();
  const client = new B2Client({
    applicationKeyId: SIM_KEY_ID,
    applicationKey: SIM_KEY,
    transport,
    userAgent: 'sdkharness-conformance',
    ...clientOptions,
  });
  await step('authorize', () => client.authorize());
  return { sim, client, transport };
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
    /* the simulator is in-process and dies with us; cleanup is best effort */
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

const OBJECT_NAME = 'st/offline.txt';

async function run() {
  // Prove "no network" rather than assume it: every outbound primitive the
  // package could reach for is replaced with a tripwire before it is imported.
  const tripped = [];
  const tripwire = (name) => (...args) => {
    tripped.push(name);
    throw new Error(name + ' was called: this check must not touch the network');
  };
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = tripwire('fetch');
  if (originalXhr !== undefined) globalThis.XMLHttpRequest = tripwire('XMLHttpRequest');

  let bucket = null;
  try {
    // Only the published specifiers -- exactly what a consumer gets from npm.
    const { B2Simulator } = await load('simulator');
    const { B2Client, BufferSource } = await load();
    if (typeof B2Simulator !== 'function') {
      throw new Failure('import the shipped fake',
        'the published package exports no B2Simulator at ./simulator');
    }

    const sim = new B2Simulator();
    const client = new B2Client({
      applicationKeyId: SIM_KEY_ID,
      applicationKey: SIM_KEY,
      transport: sim.transport(),
      userAgent: 'sdkharness-conformance',
    });
    await step('authorize offline', () => client.authorize());

    bucket = await step('create bucket offline', () =>
      client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

    const payload = Buffer.from('a round trip that never leaves the process');
    const uploaded = await step('upload offline', () =>
      bucket.upload({ fileName: OBJECT_NAME, source: new BufferSource(payload) }));
    if (uploaded.contentSha1 !== sha1(payload)) {
      throw new Failure('upload offline', 'the offline upload reported a different sha1');
    }

    const download = await step('download offline', () => bucket.download(OBJECT_NAME));
    const got = await step('download offline', () => readAll(download.body));
    if (!got.equals(payload)) {
      throw new Failure('download offline', 'the offline round trip did not return the payload');
    }

    if (tripped.length !== 0) {
      throw new Failure('no network', 'the package reached for ' + tripped.join(', '));
    }
  } finally {
    await destroy(bucket);
    globalThis.fetch = originalFetch;
    if (originalXhr !== undefined) globalThis.XMLHttpRequest = originalXhr;
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
