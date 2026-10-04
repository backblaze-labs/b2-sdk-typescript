#!/usr/bin/env node
/*
 * b2-sdk-typescript x client.sync -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   a local directory with 3 files
 *   Action  sync up; modify one and delete one; sync again with a delete
 *           policy; sync down into a fresh directory
 *   Assert  all 3 land; the remote matches the local after the second pass;
 *           the round-tripped bytes are identical
 *
 * NO DOCUMENTED CONTRACT FOUND -- this is SDK-side/ecosystem tooling, not a B2 API contract.
 * B2 documents only sync's building blocks. "Remote matches local" is read
 * through b2_list_file_names semantics: "Files that have been hidden will not be
 * returned" and it "will return each name only once" -- so the latest visible
 * version per name, not "no versions remain".
 * https://www.backblaze.com/apidocs/b2-list-file-names
 * The legs themselves are b2_upload_file ("Uploads one file and returns its
 * unique file ID"), b2_download_file_by_name, and b2_hide_file ("Hides a file
 * so that downloading by name will not find the file") or b2_delete_file_version.
 * https://www.backblaze.com/apidocs/b2-upload-file
 * https://www.backblaze.com/apidocs/b2-download-file-by-name
 * https://www.backblaze.com/apidocs/b2-hide-file
 * https://www.backblaze.com/apidocs/b2-delete-file-version
 * Which of hide/delete a delete policy issues, and the compare rule that decides
 * a file changed, are the tool's semantics, not B2's.
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
const CAPABILITY = 'client.sync';
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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'st/sync/';
const FILES = { 'one.txt': 'first file', 'two.txt': 'second file', 'three.txt': 'third file' };
const MODIFIED = 'first file, modified and longer';

async function run() {
  const { client } = await simulatorClient();
  const sync = await load('sync');
  const { synchronize, LocalFolder, B2Folder } = sync;
  for (const [name, value] of [['synchronize', synchronize], ['LocalFolder', LocalFolder], ['B2Folder', B2Folder]]) {
    if (!value) throw new Failure('setup', 'the /sync subpath exports no ' + name);
  }

  const up = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkharness-conf-sync-up-'));
  const down = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkharness-conf-sync-down-'));
  const bucket = await step('create bucket', () =>
    client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

  try {
    for (const [name, body] of Object.entries(FILES)) fs.writeFileSync(path.join(up, name), body);

    const drain = async (config) => {
      const events = [];
      for await (const event of synchronize(config)) {
        if (event.type === 'error') {
          throw new Failure('sync', 'the sync emitted an error event: ' + redact(event.message));
        }
        events.push(event);
      }
      return events;
    };

    await step('sync up', () => drain({
      source: new LocalFolder(up),
      dest: new B2Folder(bucket, PREFIX),
      bucket,
      prefix: PREFIX,
      options: { compareMode: 'size', keepMode: 'no-delete' },
    }));

    let remote = await step('sync up', () => bucket.listFileNames({ prefix: PREFIX }));
    let names = remote.files.map((file) => file.fileName).sort();
    const expectedFirst = Object.keys(FILES).map((name) => PREFIX + name).sort();
    if (names.join('|') !== expectedFirst.join('|')) {
      throw new Failure('sync up', 'the remote holds ' + names.join(',') + ' after the first pass');
    }

    fs.writeFileSync(path.join(up, 'one.txt'), MODIFIED);
    fs.unlinkSync(path.join(up, 'two.txt'));

    await step('sync up with a delete policy', () => drain({
      source: new LocalFolder(up),
      dest: new B2Folder(bucket, PREFIX),
      bucket,
      prefix: PREFIX,
      options: { compareMode: 'size', keepMode: 'delete' },
    }));

    remote = await step('sync up with a delete policy', () => bucket.listFileNames({ prefix: PREFIX }));
    names = remote.files.map((file) => file.fileName).sort();
    const expectedSecond = fs.readdirSync(up).map((name) => PREFIX + name).sort();
    if (names.join('|') !== expectedSecond.join('|')) {
      throw new Failure('sync up with a delete policy',
        'the remote holds ' + names.join(',') + ', the local holds ' + expectedSecond.join(','));
    }

    await step('sync down', () => drain({
      source: new B2Folder(bucket, PREFIX),
      dest: new LocalFolder(down),
      bucket,
      options: { compareMode: 'size', keepMode: 'no-delete' },
    }));

    const landed = fs.readdirSync(down).sort();
    const wanted = fs.readdirSync(up).sort();
    if (landed.join('|') !== wanted.join('|')) {
      throw new Failure('sync down', 'the fresh directory holds ' + landed.join(','));
    }
    for (const name of wanted) {
      const before = fs.readFileSync(path.join(up, name));
      const after = fs.readFileSync(path.join(down, name));
      if (!before.equals(after)) {
        throw new Failure('sync down', name + ' did not round-trip byte for byte');
      }
    }
    if (fs.readFileSync(path.join(down, 'one.txt'), 'utf8') !== MODIFIED) {
      throw new Failure('sync down', 'the round trip returned the pre-modification copy');
    }
  } finally {
    await destroy(bucket);
    for (const dir of [up, down]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* cleanup must not mask the verdict */
      }
    }
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
