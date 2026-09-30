#!/usr/bin/env node
/*
 * b2-sdk-typescript x files.server_side_copy -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a single-part fixture (512 bytes here; see PAYLOAD_SIZE)
 *   Action  server-side copy it to a new key
 *   Assert  the destination sha1 equals the source sha1 AND the destination
 *           fileId differs -- i.e. no local re-upload happened
 *
 * The expected values are B2's published contract. b2_copy_file "Copies an
 * entire file" from a sourceFileId ("The ID of the source file being copied")
 * to fileName ("The name of the new file being created"); the request carries
 * no file bytes. Its response fileId is "The unique identifier for this version
 * of this file" and contentSha1 is "The SHA1 of the bytes stored in the file",
 * so an entire copy reports the source's sha1 under a new fileId.
 * https://www.backblaze.com/apidocs/b2-copy-file
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
const CAPABILITY = 'files.server_side_copy';
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

const SOURCE_NAME = 'st/copy-source.bin';
const DEST_NAME = 'st/copy-destination.bin';
// Single-part on purpose: the harness simulator reports a 5,000-byte
// recommendedPartSize (bin/simulator/serve.mjs, PROFILE); above it the SDK
// uploads the fixture as a large file (dist/bucket.js:147), whose contentSha1
// is not the whole-file hash this scenario asserts.
const PAYLOAD_SIZE = 512;

async function run() {
  const uploadCalls = [];
  const { client } = await simulatorClient({
    wrap: (inner) => ({
      async send(request) {
        const endpoint = new URL(request.url).pathname.split('/').pop();
        if (endpoint === 'b2_upload_file' || endpoint === 'b2_upload_part') uploadCalls.push(endpoint);
        return inner.send(request);
      },
    }),
  });
  const { BufferSource } = await load();

  const payload = filler(PAYLOAD_SIZE, 11);
  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    const source = await step('fixture', () =>
      bucket.upload({ fileName: SOURCE_NAME, source: new BufferSource(payload) }));

    const before = uploadCalls.length;
    const copied = await step('server-side copy', () =>
      bucket.copyFile({ sourceFileId: source.fileId, fileName: DEST_NAME }));

    if (copied.fileId === source.fileId) {
      throw new Failure('server-side copy', 'the copy reported the source fileId');
    }
    if (copied.fileName !== DEST_NAME) {
      throw new Failure('server-side copy', 'the copy landed under a different name');
    }
    if (copied.contentSha1 !== source.contentSha1) {
      throw new Failure('server-side copy', 'the destination sha1 differs from the source sha1');
    }
    if (copied.contentLength !== PAYLOAD_SIZE) {
      throw new Failure('server-side copy',
        'the destination is ' + copied.contentLength + ' bytes, expected ' + PAYLOAD_SIZE);
    }
    if (uploadCalls.length !== before) {
      throw new Failure('server-side copy',
        'the copy re-uploaded bytes: ' + (uploadCalls.length - before) + ' upload calls were issued');
    }

    const download = await step('verify destination', () => bucket.download(DEST_NAME));
    const got = await step('verify destination', () => readAll(download.body));
    if (sha1(got) !== source.contentSha1) {
      throw new Failure('verify destination', 'the copied bytes do not hash to the source sha1');
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
