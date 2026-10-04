#!/usr/bin/env node
/*
 * b2-sdk-typescript x api.retry_after_429 -- resilience check.
 *
 * Written from the reference check, bin/resilience/b2-sdk-python/upload.retry_503.
 * The contract is bin/resilience/README.md; the question is the api.retry_after_429 row of
 * bin/resilience/scenarios.tsv.
 *
 * Fault   fault b2_list_file_names 429 too_many_requests retryAfter=2 (count 1), armed after setup
 * Assert  the end state: the listing names exactly the fixture; the recovery path,
 *         from GET /journal: one injected 429, then a successful b2_list_file_names;
 *         and timing, a LOWER BOUND only: the whole list call took >= 2.0 s
 *         (weak evidence, stated on a NOTE line -- the journal has no timestamps)
 *
 * The expected behaviour is B2's, not the tool's.
 * The Integration Checklist, Error Handling, 429: "the response may also include a
 * 'Retry-After' header where the value is the number of seconds a developer should wait."
 * https://www.backblaze.com/docs/cloud-storage-integration-checklist
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API is taken from
 * docs/sdks/b2-sdk-typescript/card.md and the package's published types.
 */
'use strict';

const SCENARIO = 'api.retry_after_429';

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

const OBJECT_NAME = 'res/retry_after_429.txt';
const ARM_PATH = '/faults';
const FAULT = { on: 'b2_list_file_names', status: 429, code: 'too_many_requests', count: 1, retryAfter: 2 };
const FAULTED = (e) => e.endpoint === 'b2_list_file_names' && e.fault === 'injected' && e.status === 429;
const FLOOR_S = 2.0;

async function run() {
  const { sdk, bucket } = await authorizedBucket();
  await step('upload fixture', () =>
    bucket.upload({ fileName: OBJECT_NAME, source: new sdk.BufferSource(Buffer.from('sdkharness resilience listing')) }));

  await step('arm fault', () => control('POST', ARM_PATH, FAULT));
  const started = performance.now();
  await listExactly(bucket, OBJECT_NAME);
  const elapsed = (performance.now() - started) / 1000;

  const entries = await journal();
  const faulted = entries.filter(FAULTED);
  if (faulted.length !== 1) throw new Failure('journal', `${faulted.length} injected 429 on b2_list_file_names, expected 1`);
  if (after(entries, faulted[0].seq, 'b2_list_file_names', 200).length === 0) {
    throw new Failure('journal', 'no successful b2_list_file_names after the 429');
  }
  note(`the whole list call took ${elapsed.toFixed(2)} s against a floor of ${FLOOR_S} s; `
    + 'a lower bound on the call, not a measured gap between attempts (the journal has no timestamps)');
  if (elapsed < FLOOR_S) {
    throw new Failure('recovery path', `retried after ${elapsed.toFixed(2)} s, sooner than the 2 s Retry-After`);
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
