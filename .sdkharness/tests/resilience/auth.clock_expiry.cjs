#!/usr/bin/env node
/*
 * b2-sdk-typescript x auth.clock_expiry -- resilience check.
 *
 * Written from the reference check, bin/resilience/b2-sdk-python/upload.retry_503.
 * The contract is bin/resilience/README.md; the question is the auth.clock_expiry row of
 * bin/resilience/scenarios.tsv.
 *
 * Fault   clock 86400001 -- POST /clock {advanceMs: 86400001}, after setup, so the
 *         account token the one live B2Client holds is past its 24 h life.
 *         Nothing is injected: the 401 is the simulator's own
 * Assert  the recovery path, from GET /journal: after the advance, a REAL 401 (fault
 *         null), then b2_authorize_account, then a successful b2_list_file_names;
 *         and the end state: the listing names exactly the fixture
 *
 * The expected behaviour is B2's, not the tool's.
 * b2_authorize_account: "This authorization token is valid for at most 24 hours."
 * https://www.backblaze.com/apidocs/b2-authorize-account
 * The Integration Checklist, Error Handling, 401: "When the code is either bad_auth_token
 * or expired_auth_token you should call b2_authorize_account again to get a new auth token."
 * https://www.backblaze.com/docs/cloud-storage-integration-checklist
 *
 * `needs: long-lived-session` is met: one B2Client over its default in-memory
 * AccountInfo is one session that outlives the virtual advance, and the card
 * records that "Auth state lives behind a swappable AccountInfo (default
 * in-memory ...). 401s trigger a coalesced re-authorize" (card.md, Auth model:
 * src/client.ts:198-210, src/auth/reauth-coalescer.ts).
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built. The API is taken from
 * docs/sdks/b2-sdk-typescript/card.md and the package's published types.
 */
'use strict';

const SCENARIO = 'auth.clock_expiry';

// The closed reason set, mirrored from bin/resilience/README.md. This
// scenario's `needs` names a precondition, so no-client-option is available
// to it; the header above says why this check does not emit it.
const REASONS = new Set(['missing-runtime', 'no-client-option']);

const crypto = require('node:crypto');

const SLUG = 'b2-sdk-typescript';

// The simulator's fixed test credential, which the runner also injects as
// B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY. Not a secret, but the redactor
// keeps it out of every detail string all the same.
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
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  for (const secret of SECRETS) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
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

async function control(method, path, body) {
  const response = await fetch(process.env.RESILIENCE_CONTROL_URL + path, {
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

/** Import this checkout. An absent package is missing-runtime. */
async function load() {
  try {
    return await import('@backblaze-labs/b2-sdk');
  } catch {
    throw new Amber('missing-runtime', '@backblaze-labs/b2-sdk is unavailable -- build this exact checkout first');
  }
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
  const realm = process.env.RESILIENCE_SIMULATOR_URL;
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

const OBJECT_NAME = 'res/clock_expiry.txt';
const ARM_PATH = '/clock';
const FAULT = { advanceMs: 86400001 };
const FAULTED = (e) => e.status === 401 && e.fault === null;

async function run() {
  const { sdk, bucket } = await authorizedBucket();
  await step('upload fixture', () =>
    bucket.upload({ fileName: OBJECT_NAME, source: new sdk.BufferSource(Buffer.from('sdkharness resilience listing')) }));
  const before = Math.max(...(await journal()).map((e) => e.seq));
  await step('advance clock', () => control('POST', ARM_PATH, FAULT));
  await listExactly(bucket, OBJECT_NAME);

  const entries = (await journal()).filter((e) => e.seq > before);
  if (entries.some((e) => e.fault !== null)) {
    throw new Failure('journal', 'a fault was injected; this scenario must see only real answers');
  }
  const expired = entries.filter(FAULTED);
  if (expired.length === 0) {
    throw new Failure('journal', 'no real 401 after the 24 h advance; the expired token was never presented');
  }
  const reauth = after(entries, expired[0].seq, 'b2_authorize_account', 200);
  if (reauth.length === 0) {
    throw new Failure('recovery path', `b2_authorize_account was not called again after the real 401 on ${expired[0].endpoint}`);
  }
  if (after(entries, reauth[0].seq, 'b2_list_file_names', 200).length === 0) {
    throw new Failure('recovery path', 'no successful b2_list_file_names after the reauthorization');
  }
  note(`the real 401 came from ${expired[0].endpoint}`);
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
