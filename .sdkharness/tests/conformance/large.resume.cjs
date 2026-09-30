#!/usr/bin/env node
/*
 * b2-sdk-typescript x large.resume -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a large upload interrupted after at least one part completed
 *   Action  re-run the same upload
 *   Assert  an unfinished large file existed; the rerun reuses that fileId
 *           rather than calling b2_start_large_file again; it uploads fewer
 *           parts than the total; the final bytes are correct
 *
 * DOCS -- "Any number of large files can be in progress at the same time.
 * You can use b2_list_unfinished_large_files to get a list of them. For any
 * one unfinished large file, you can use b2_list_parts to get a list of the
 * parts that were uploaded so far."
 * https://www.backblaze.com/docs/cloud-storage-create-large-files-with-the-native-api
 * b2_list_parts: "Lists the parts that have been uploaded for a large file
 * that has not completed uploading" https://www.backblaze.com/apidocs/b2-list-parts
 * B2 makes reusing the unfinished fileId POSSIBLE; that a rerun reuses it
 * instead of calling b2_start_large_file is the capability under test, not a
 * B2 promise.
 *
 * This is a real, reported gap, not a check bug: resume discovery adopts the
 * unfinished file's fileId, then discards the parts it just discovered
 * (preUploaded = new Map()), so every part is re-uploaded instead of resumed.
 * Filed and open:
 * https://github.com/backblaze-labs/b2-sdk-typescript/issues/302
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
const CAPABILITY = 'large.resume';
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

const OBJECT_NAME = 'st/resume.bin';
const PART_SIZE = 10000;
const TOTAL_PARTS = 5;
const PAYLOAD_SIZE = PART_SIZE * TOTAL_PARTS;
const PARTS_BEFORE_INTERRUPT = 2;

async function run() {
  const endpoints = [];
  // The interruption is CLIENT-side, as a customer's is: once
  // PARTS_BEFORE_INTERRUPT parts have landed, the "process dies" -- no further
  // request leaves it, b2_cancel_large_file included, so the realm is left
  // holding exactly what a killed upload leaves behind. Nothing asks the realm
  // to misbehave.
  let interrupting = false;
  let partsLanded = 0;
  const { client } = await simulatorClient({
    retry: { maxRetries: 0 },
    wrap: (inner) => ({
      async send(request) {
        const endpoint = new URL(request.url).pathname.split('/').pop();
        if (interrupting && (partsLanded >= PARTS_BEFORE_INTERRUPT || endpoint === 'b2_cancel_large_file')) {
          throw new Error('client interrupted before sending ' + endpoint);
        }
        endpoints.push(endpoint);
        const response = await inner.send(request);
        if (endpoint === 'b2_upload_part' && response.status === 200) partsLanded += 1;
        return response;
      },
    }),
  });
  const { BufferSource } = await load();

  const payload = filler(PAYLOAD_SIZE, 31);
  const expectedSha1 = sha1(payload);

  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    interrupting = true;

    let interrupted = false;
    try {
      await bucket.upload({
        fileName: OBJECT_NAME,
        source: new BufferSource(payload),
        partSize: PART_SIZE,
        concurrency: 1,
        resume: true,
      });
    } catch {
      interrupted = true;
    }
    interrupting = false;
    if (!interrupted) {
      throw new Failure('interrupt', 'the client-side interruption did not interrupt the upload');
    }

    const unfinished = [];
    await step('list unfinished', async () => {
      for await (const candidate of bucket.paginateUnfinishedLargeFiles({})) unfinished.push(candidate);
    });
    if (unfinished.length !== 1 || unfinished[0].fileName !== OBJECT_NAME) {
      throw new Failure('list unfinished',
        'expected exactly one unfinished large file for ' + OBJECT_NAME + ', saw ' + unfinished.length);
    }
    const startedParts = [];
    await step('list parts', async () => {
      for await (const part of bucket.paginateParts(unfinished[0].fileId)) startedParts.push(part);
    });
    if (startedParts.length < 1) {
      throw new Failure('list parts', 'the interrupted upload left no completed parts to reuse');
    }

    endpoints.length = 0;
    // Resume via the EXPLICIT resumeFileId mode -- the one that reuses already
    // uploaded parts by SHA-1. b2-sdk-typescript's `resume: true` (auto-discovery)
    // deliberately re-uploads every part instead of trusting an unfinished file's
    // stored parts (documented: src/upload/large.ts:355-365, README, CHANGELOG --
    // a bounded-discovery safety choice, since a stored part carries no proof of
    // which writer produced it). Part reuse is a resumeFileId-only guarantee here,
    // so the standardized "uploads fewer parts" assertion must drive that mode --
    // matching what b2-sdk-python and blazer verify by default.
    const finished = await step('rerun', () => bucket.upload({
      fileName: OBJECT_NAME,
      source: new BufferSource(payload),
      partSize: PART_SIZE,
      concurrency: 1,
      resumeFileId: unfinished[0].fileId,
    }));

    if (endpoints.includes('b2_start_large_file')) {
      throw new Failure('rerun',
        'the rerun called b2_start_large_file instead of resuming the unfinished large file');
    }
    const reuploaded = endpoints.filter((name) => name === 'b2_upload_part').length;
    if (reuploaded >= TOTAL_PARTS) {
      throw new Failure('rerun',
        'the rerun re-uploaded all ' + reuploaded + ' of ' + TOTAL_PARTS + ' parts, reusing none of the '
        + startedParts.length + ' already stored -- resume discovery adopts the large file but discards its parts');
    }

    const download = await step('verify', () => bucket.download(OBJECT_NAME));
    const got = await step('verify', () => readAll(download.body));
    if (sha1(got) !== expectedSha1) {
      throw new Failure('verify', 'the resumed upload did not reassemble the original bytes');
    }
    if (finished.contentLength !== PAYLOAD_SIZE) {
      throw new Failure('verify',
        'the finished file is ' + finished.contentLength + ' bytes, expected ' + PAYLOAD_SIZE);
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
