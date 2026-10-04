#!/usr/bin/env node
/*
 * b2-sdk-typescript x upload.cap_exceeded_403 -- resilience check.
 *
 * Written from the reference check, bin/resilience/b2-sdk-python/upload.retry_503.
 * The contract is bin/resilience/README.md; the question is the upload.cap_exceeded_403 row of
 * bin/resilience/scenarios.tsv.
 *
 * Fault   fault b2_upload_file 403 cap_exceeded (count 1), armed after setup
 * Assert  the end state: the upload REJECTS with the SDK's B2Error to the caller;
 *         and the recovery path, from GET /journal: exactly one b2_upload_file
 *         (the 403), so the tool did not retry
 *
 * The expected behaviour is B2's, not the tool's.
 * b2_upload_file's 403 cap_exceeded: "Usage cap exceeded."
 * https://www.backblaze.com/apidocs/b2-upload-file
 * The Integration Checklist, Error Handling, 403 cap exceeded: "Quit immediately and
 * inform the user they need to log in and review their B2 Caps."
 * https://www.backblaze.com/docs/cloud-storage-integration-checklist
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API is taken from
 * docs/sdks/b2-sdk-typescript/card.md and the package's published types.
 */
'use strict';

const SCENARIO = 'upload.cap_exceeded_403';

// The closed reason set, mirrored from bin/resilience/README.md. This
// scenario's `needs` is `-`, so no-client-option is not available to it.
const REASONS = new Set(['missing-runtime']);

const crypto = require('node:crypto');

const SLUG = 'b2-sdk-typescript';

// The simulator's fixed test credential, which the runner also injects as
// B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY. Not a secret, but the redactor
// keeps it out of every detail string all the same.
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

class Failure extends Error {
  constructor(step, detail) {
    super(detail);
    this.step = step;
    this.detail = detail;
  }
}

// A credential NEVER reaches a detail: only an error class and its message,
// with every registered secret substituted out and the whole thing truncated.
function redact(value) {
  let text = value instanceof Error ? guard.describeError(value) : String(value);
  for (const secret of SECRETS) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 400);
}

function say(verdict) {
  process.stdout.write(`RESILIENCE ${SLUG} ${SCENARIO} @simulator: ${verdict}\n`);
}

function note(text) {
  process.stdout.write(`NOTE ${SLUG} ${SCENARIO}: ${text}\n`);
}

// One step. Any error becomes a FAIL naming the step. There is no
// unreachable/unauthorized amber: the runner supplies the server and the
// credential, so either failing is a harness defect.
async function step(name, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Amber || error instanceof Failure) throw error;
    throw new Failure(name, redact(error));
  }
}

/** The fault-control origin, held to the same loopback rule as the simulator. */
function controlOrigin() {
  const origin = guard.originFromEnv('RESILIENCE_CONTROL_URL',
    (message) => new Failure('configuration', message));
  if (!origin) throw new Failure('setup', 'RESILIENCE_CONTROL_URL is unset -- run under bin/run-resilience.sh');
  return origin;
}

async function control(method, path, body) {
  const response = await fetch(controlOrigin() + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`control ${method} ${path} answered ${response.status}`);
  return response.json();
}

async function journal() {
  return (await step('journal', () => control('GET', '/journal'))).entries;
}

/** Entries on `endpoint` later than `seq`, optionally with one status. */
function after(entries, seq, endpoint, status) {
  return entries.filter((e) => e.seq > seq && e.endpoint === endpoint
    && (status === undefined || e.status === status));
}

/**
 * Import this checkout's built SDK. Only a missing build is amber; a built SDK
 * that throws on import is a FAIL (an SDK regression, not an unanswerable question).
 */
async function load() {
  return guard.importBuiltSdk('@backblaze-labs/b2-sdk', {
    missing: (detail) => new Amber('missing-runtime', detail),
    broken: (detail) => new Failure('import', detail),
  });
}

/**
 * An authorized B2Client on the SDK's default transport, pointed at the
 * runner's control-enabled simulator (RESILIENCE_SIMULATOR_URL), plus a fresh
 * bucket. `options` go to B2ClientOptions. The SSRF guard is off
 * (`allowedHostSuffixes: []`, the documented test-setup switch), exactly as in
 * bin/conformance/b2-sdk-typescript: the guard rejects every literal IP after
 * authorize, so no loopback realm is reachable with it on.
 */
async function authorizedBucket(options = {}) {
  const sdk = await load();
  const realm = guard.originFromEnv('RESILIENCE_SIMULATOR_URL',
    (message) => new Failure('configuration', message));
  if (!realm) throw new Failure('setup', 'RESILIENCE_SIMULATOR_URL is unset -- run under bin/run-resilience.sh');
  const client = new sdk.B2Client({
    applicationKeyId: SIM_KEY_ID,
    applicationKey: SIM_KEY,
    realm,
    userAgent: 'sdkharness-resilience',
    allowedHostSuffixes: [],
    ...options,
  });
  await step('authenticate', () => client.authorize());
  const bucket = await step('create bucket', () => client.createBucket({
    bucketName: `sdkharness-res-${crypto.randomBytes(6).toString('hex')}`,
    bucketType: 'allPrivate',
  }));
  return { sdk, client, bucket };
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

/** Upload `payload` as `name`, then read it back by name and compare. */
async function uploadAndVerify(sdk, bucket, name, payload) {
  let uploaded;
  try {
    uploaded = await bucket.upload({ fileName: name, source: new sdk.BufferSource(payload) });
  } catch (error) {
    const tries = (await journal()).filter((e) => e.endpoint === 'b2_upload_file').length;
    throw new Failure('upload', `${redact(error)} reached the caller after ${tries} `
      + 'b2_upload_file attempt(s); the upload was not recovered');
  }
  if (!uploaded || uploaded.contentSha1 !== sha1(payload)) {
    throw new Failure('upload', 'the returned contentSha1 does not match the bytes sent');
  }
  const download = await step('download', () => bucket.download(name));
  const got = await step('download', () => readAll(download.body));
  if (!got.equals(payload)) throw new Failure('round trip', 'downloaded bytes differ from what was uploaded');
  return uploaded;
}

/** List the whole bucket and require exactly the one fixture name. */
async function listExactly(bucket, name) {
  const listed = await step('list', () => bucket.listFileNames({}));
  const names = listed.files.map((file) => file.fileName);
  if (names.length !== 1 || names[0] !== name) {
    throw new Failure('listing', `listed ${names.length} names, expected exactly the one fixture`);
  }
}

/**
 * The fresh-URL recovery path on `endpoint`: exactly one entry matching
 * `faulted`, then a 200 on a DIFFERENT, non-null uploadUrlId. Returns both.
 */
function freshUrlRetry(entries, endpoint, faulted, label) {
  const hits = entries.filter(faulted);
  if (hits.length !== 1) throw new Failure('journal', `${hits.length} ${label} on ${endpoint}, expected 1`);
  const retries = after(entries, hits[0].seq, endpoint, 200);
  if (retries.length === 0) throw new Failure('journal', `no successful ${endpoint} after the ${label}`);
  if (retries[0].uploadUrlId == null || retries[0].uploadUrlId === hits[0].uploadUrlId) {
    throw new Failure('recovery path', `the retry reused the upload URL that got the ${label}`);
  }
  return { fault: hits[0], retry: retries[0] };
}

const OBJECT_NAME = 'res/cap_exceeded_403.txt';
const ARM_PATH = '/faults';
const FAULT = { on: 'b2_upload_file', status: 403, code: 'cap_exceeded', count: 1 };
const FAULTED = (e) => e.endpoint === 'b2_upload_file' && e.fault === 'injected' && e.status === 403;

async function run() {
  const { sdk, bucket } = await authorizedBucket();
  const payload = filler(1024);
  await step('arm fault', () => control('POST', ARM_PATH, FAULT));
  let surfaced;
  try {
    await bucket.upload({ fileName: OBJECT_NAME, source: new sdk.BufferSource(payload) });
  } catch (error) {
    surfaced = error;
  }
  if (surfaced === undefined) throw new Failure('upload', 'the upload succeeded; the cap_exceeded never reached the caller');
  if (!(surfaced instanceof sdk.B2Error)) {
    throw new Failure('upload', `rejected with ${redact(surfaced)}, which is not the SDK's B2Error`);
  }
  note(`the caller received ${surfaced.name}`);

  const uploads = (await journal()).filter((e) => e.endpoint === 'b2_upload_file');
  if (uploads.filter(FAULTED).length !== 1) {
    throw new Failure('journal', 'the injected 403 on b2_upload_file did not fire exactly once');
  }
  if (uploads.length !== 1) {
    throw new Failure('recovery path', `${uploads.length} b2_upload_file calls; cap_exceeded must not be retried`);
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
