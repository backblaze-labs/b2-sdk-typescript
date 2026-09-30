#!/usr/bin/env node
/*
 * b2-sdk-typescript x bucket.replication_helper -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. Neither is negotiable here.
 *
 * Scenario (approved 2026-09-22, one per capability, identical on every tool
 * that claims it):
 *
 *   Setup   two buckets
 *   Action  run the setup helper end to end, then the status / monitor call
 *   Assert  the helper created both source and destination configuration;
 *           status reports the expected counts
 *
 * NO DOCUMENTED CONTRACT FOUND for the helper itself -- only for the endpoints
 * under it. B2 documents that a working replication needs BOTH sides: "one rule
 * for setting up source with asReplicationSource section and second rule for
 * setting up the destination with asReplicationDestination section", and that
 * b2_list_buckets returns them.
 * https://www.backblaze.com/docs/cloud-storage-create-a-cloud-replication-rule-with-the-native-api
 * https://www.backblaze.com/apidocs/b2-update-bucket
 * The status leg does trace to B2: b2_upload_file returns replicationStatus,
 * "either PENDING, COMPLETED, FAILED, or REPLICA", omitted "when the file is not
 * part of a replication rule".
 * https://www.backblaze.com/apidocs/b2-upload-file
 * searched: the package README (https://www.npmjs.com/package/@backblaze-labs/b2-sdk) -- no
 * replication helper or monitor is documented, so the counts are read from the
 * documented per-file status: one file inside the rule reports PENDING (on
 * upload and through b2_get_file_info), one outside it reports none.
 * https://www.backblaze.com/apidocs/b2-get-file-info
 * NEEDS REVIEW: as in bucket.replication_config, docs say the source key must
 * have readFiles readFileLegalHolds readFileRetentions and the destination key
 * writeFiles writeFileLegalHolds writeFileRetentions; both keys minted below lack
 * the legal-hold and retention rights.
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
const CAPABILITY = 'bucket.replication_helper';
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

const RULE_NAME = 'sdkharnessconfhelper';

async function run() {
  const { client } = await simulatorClient();
  const { BufferSource } = await load();

  let source = null;
  let destination = null;
  let sourceKey = null;
  let destinationKey = null;

  try {
    destination = await step('create destination bucket', () =>
      client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));
    source = await step('create source bucket', () =>
      client.createBucket({ bucketName: bucketName(), bucketType: 'allPrivate' }));

    sourceKey = await step('create source key', () => client.createKey({
      keyName: 'sdkharness-conf-helper-src',
      capabilities: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles',
        'readBucketReplications', 'writeBucketReplications'],
    }));
    neverPrint(sourceKey.applicationKey);
    destinationKey = await step('create destination key', () => client.createKey({
      keyName: 'sdkharness-conf-helper-dst',
      capabilities: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles',
        'readBucketReplications', 'writeBucketReplications'],
    }));
    neverPrint(destinationKey.applicationKey);

    // Destination side first: B2 documents both halves but no order, and the
    // harness simulator (strictAuth) refuses a source rule whose destination
    // has no key mapping yet (bin/simulator/vendor/simulator/index.js:1340).
    await step('helper: destination side', () => destination.setReplication({
      asReplicationSource: null,
      asReplicationDestination: {
        sourceToDestinationKeyMapping: {
          [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
        },
      },
    }));

    // Then the source side, through the named helper.
    await step('helper: source side', () => source.addReplicationRule({
      destinationBucketId: destination.id,
      fileNamePrefix: 'st/rep/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: RULE_NAME,
    }, { sourceApplicationKeyId: sourceKey.applicationKeyId }));

    const sourceConfig = await step('read back source', () => source.getReplication());
    const asSource = sourceConfig && sourceConfig.value && sourceConfig.value.asReplicationSource;
    if (!asSource || !asSource.replicationRules.some((r) => r.replicationRuleName === RULE_NAME)) {
      throw new Failure('read back source', 'the helper left no source rule behind');
    }

    const destinationConfig = await step('read back destination', () => destination.getReplication());
    const asDestination = destinationConfig && destinationConfig.value
      && destinationConfig.value.asReplicationDestination;
    if (!asDestination || !asDestination.sourceToDestinationKeyMapping) {
      throw new Failure('read back destination', 'the helper left no destination configuration behind');
    }
    if (asDestination.sourceToDestinationKeyMapping[sourceKey.applicationKeyId]
      !== destinationKey.applicationKeyId) {
      throw new Failure('read back destination', 'the key mapping did not round-trip');
    }

    // The status half. This SDK exposes no replication monitor or counts, so
    // the per-file replicationStatus is the status surface it does have.
    const uploaded = await step('status', () => source.upload({
      fileName: 'st/rep/replicated.txt',
      source: new BufferSource(Buffer.from('replicated payload')),
    }));
    const outside = await step('status', () => source.upload({
      fileName: 'st/not-replicated.txt',
      source: new BufferSource(Buffer.from('outside the rule')),
    }));

    if (uploaded.replicationStatus !== 'PENDING') {
      throw new Failure('status',
        'a file matching an enabled source rule reports replicationStatus '
        + uploaded.replicationStatus + ', expected PENDING');
    }
    const info = await step('status', () =>
      source.file('st/rep/replicated.txt').getFileInfo(uploaded.fileId));
    if (info.replicationStatus !== 'PENDING') {
      throw new Failure('status',
        'b2_get_file_info reports replicationStatus ' + info.replicationStatus + ', expected PENDING');
    }
    if (outside.replicationStatus !== undefined && outside.replicationStatus !== null) {
      throw new Failure('status',
        'a file outside every rule reports replicationStatus ' + outside.replicationStatus
        + ', expected it omitted');
    }

    note('this SDK ships no replication monitor and no count API, so "status reports expected '
      + 'counts" is asserted as one PENDING version inside the rule and one un-replicated version '
      + 'outside it, read through the documented per-file status -- weaker than a count read back '
      + 'from the service.');
  } finally {
    if (source) {
      try {
        await source.removeReplicationRule(RULE_NAME);
      } catch {
        /* best effort */
      }
    }
    for (const key of [sourceKey, destinationKey]) {
      if (!key) continue;
      try {
        await client.deleteKey(key.applicationKeyId);
      } catch {
        /* best effort */
      }
    }
    await destroy(source);
    await destroy(destination);
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
