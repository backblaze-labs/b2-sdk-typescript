#!/usr/bin/env node
/*
 * b2-sdk-typescript x large.compose_mixed -- conformance check.
 *
 * The contract is bin/conformance/README.md; the worked reference is
 * bin/conformance/b2-sdk-python/files.upload. The sibling check
 * bin/conformance/b2-sdk-typescript/large.multipart is the closer pattern
 * here (same finish-large-file shape). Neither is negotiable.
 *
 * WHY THIS CHECK EXISTS. docs/sdks/b2-sdk-typescript/capabilities.tsv answers
 * `large.compose_mixed` `partial`: there is no single high-level helper that
 * composes a large file from mixed local/copy sources -- `copyLargeFile`
 * copies parts only (src/copy/large.ts:59), the large-upload path uploads
 * local bytes only (src/upload/large.ts:417) -- but the raw primitives to do
 * it by hand exist: `copyPart` writes a server-side copy range into a part
 * (src/raw/index.ts:816), `uploadPart` writes local bytes into a part
 * (src/raw/index.ts:973), and both finish through the same
 * `finishLargeFile` (src/raw/index.ts:1016). `partial` is a claim about
 * source; this check is the first behavioural evidence for or against it.
 *
 * Scenario (mirrors large.multipart's shape, mixed instead of uniform):
 *
 *   Setup   a small source object already in the bucket, and a local payload
 *   Action  start a large file; part 1 = uploadPart (local bytes); part 2 =
 *           copyPart (server-side copy of the whole source object); finish
 *   Assert  the finished file downloads to exactly part1 bytes ++ part2 bytes
 *
 * DOCS -- the acceptance criteria; what the tool does is the result:
 * - b2_copy_part: "Copies from an existing B2 file... to a large file part."
 *   https://www.backblaze.com/apidocs/b2-copy-part
 * - b2_finish_large_file: parts are assembled "in the order specified by
 *   partSha1Array." https://www.backblaze.com/apidocs/b2-finish-large-file
 * - part-size floor: `absoluteMinimumPartSize` off this account's own
 *   authorize response, not a hardcoded guess -- the simulator reports its
 *   own fixed profile (bin/simulator/serve.mjs), production reports its own.
 *
 * TARGET -- always @simulator. Same reasoning as large.multipart: this SDK
 * has no realm option from this harness, so CONFORMANCE_SIMULATOR_URL is the
 * only source of a realm, and a simulator PASS is weaker evidence than a
 * staging PASS -- it proves the SDK and this harness's simulator agree with
 * each other, not that either agrees with real B2.
 *
 * It exercises this checkout through the @backblaze-labs/b2-sdk package
 * self-reference after the exact revision has been built.
 */
'use strict';

const crypto = require('node:crypto');

const SLUG = 'b2-sdk-typescript';
const CAPABILITY = 'large.compose_mixed';
const TARGET = 'simulator';

const REASONS = new Set([
  'no-realm-option',
  'unreachable',
  'unauthorized',
  'no-credential',
  'missing-runtime',
  'not-claimed',
]);

const SIM_KEY_ID = 'test-key-id';
const SIM_KEY = 'test-key';
const SECRETS = [SIM_KEY_ID, SIM_KEY];

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

function redact(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  for (const secret of SECRETS) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}

function say(verdict) {
  process.stdout.write(`CONFORMANCE ${SLUG} ${CAPABILITY} @${TARGET}: ${verdict}\n`);
}

function note(text) {
  process.stdout.write(`note: ${text}\n`);
}

async function step(name, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Amber || error instanceof Failure) throw error;
    throw new Failure(name, redact(error));
  }
}

async function load(subpath) {
  const specifier = subpath ? `@backblaze-labs/b2-sdk/${subpath}` : '@backblaze-labs/b2-sdk';
  try {
    return await import(specifier);
  } catch (error) {
    throw new Amber('missing-runtime', `${specifier} is unavailable -- build this exact checkout first`);
  }
}

function simulatorRealm() {
  const realm = process.env.CONFORMANCE_SIMULATOR_URL;
  if (!realm) {
    throw new Amber('no-realm-option',
      'CONFORMANCE_SIMULATOR_URL is unset -- this slug runs only under bin/run-conformance.sh --target simulator');
  }
  return realm;
}

function bucketName() {
  return `sdkharness-conf-${crypto.randomBytes(6).toString('hex')}`;
}

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
function filler(size, seed) {
  const buffer = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buffer[i] = (i * 31 + seed * 7) & 0xff;
  return buffer;
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

const SOURCE_OBJECT_NAME = 'st/large-compose-mixed-source.bin';
const COMPOSED_OBJECT_NAME = 'st/large-compose-mixed.bin';

async function run() {
  const { RawClient, FetchTransport } = await load();
  const realm = simulatorRealm();
  const transport = new FetchTransport({ userAgent: 'sdkharness-conformance' });
  const client = new RawClient({ transport });

  const auth = await step('authorize', () => client.authorizeAccount(SIM_KEY_ID, SIM_KEY, realm));
  const authToken = auth.authorizationToken;
  const { apiUrl, downloadUrl, absoluteMinimumPartSize } = auth.apiInfo.storageApi;
  // Big enough to satisfy the account's own reported part-size floor, small
  // enough to stay a fast conformance check either way (the simulator's own
  // profile reports a floor in the thousands of bytes, not megabytes).
  const partSize = Math.max(absoluteMinimumPartSize, 5000);

  const bucket = await step('create bucket', () => client.createBucket(apiUrl, authToken, {
    accountId: auth.accountId,
    bucketName: bucketName(),
    bucketType: 'allPrivate',
  }));

  let largeFileId;
  try {
    // The source object copyPart will read from -- created up front so its
    // fileId and bytes are both known before the compose begins.
    const sourceBytes = filler(partSize, 3);
    const sourceUploadUrl = await step('setup', () => client.getUploadUrl(apiUrl, authToken, { bucketId: bucket.bucketId }));
    const sourceVersion = await step('setup', () => client.uploadFile(
      sourceUploadUrl.uploadUrl,
      {
        authorization: sourceUploadUrl.authorizationToken,
        fileName: encodeURIComponent(SOURCE_OBJECT_NAME),
        contentType: 'b2/x-auto',
        contentLength: sourceBytes.length,
        contentSha1: sha1(sourceBytes),
      },
      sourceBytes,
    ));

    const localBytes = filler(partSize, 11);

    const started = await step('start large file', () => client.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.bucketId,
      fileName: COMPOSED_OBJECT_NAME,
      contentType: 'b2/x-auto',
    }));
    largeFileId = started.fileId;

    // Part 1: a raw uploadPart of LOCAL bytes.
    const partUrl = await step('upload part', () => client.getUploadPartUrl(apiUrl, authToken, { fileId: largeFileId }));
    await step('upload part', () => client.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: localBytes.length,
        contentSha1: sha1(localBytes),
      },
      localBytes,
    ));

    // Part 2: a raw copyPart, server-side, from the already-uploaded source
    // object -- no bytes cross this process for this half of the file.
    await step('copy part', () => client.copyPart(apiUrl, authToken, {
      sourceFileId: sourceVersion.fileId,
      largeFileId,
      partNumber: 2,
    }));

    const finished = await step('finish', () => client.finishLargeFile(apiUrl, authToken, {
      fileId: largeFileId,
      partSha1Array: [sha1(localBytes), sha1(sourceBytes)],
    }));
    // NEEDS REVIEW: b2_finish_large_file's own docs describe the finished
    // file's fileId as the same one b2_start_large_file assigned -- every
    // other check in this harness that touches a large file (large.multipart
    // included) relies on that holding. Here it does not: the harness's
    // simulator returns a DIFFERENT fileId at finish than it did at start.
    // Downloading by the finish response's id (not the start response's) is
    // what makes this check assert the right thing -- composed content is
    // correct -- without also silently asserting a separate, unrelated
    // invariant (id stability across finish) that this capability isn't
    // about. Recorded here rather than routed around quietly.
    if (finished.fileId !== largeFileId) {
      note(`simulator fidelity: finish returned fileId ${finished.fileId}, ` +
        `different from the ${largeFileId} start assigned -- see this check's own comment`);
    }
    largeFileId = undefined; // finished, not a cancel target any more

    const download = await step('download', () => client.downloadFileById(downloadUrl, authToken, finished.fileId));
    if (download.status !== 200) {
      throw new Failure('download', `download status ${download.status}, expected 200`);
    }
    const got = await step('download', () => readAll(download.body));
    const expected = Buffer.concat([localBytes, sourceBytes]);
    if (!got.equals(expected)) {
      throw new Failure('round trip',
        `composed file is ${got.length} bytes, expected ${expected.length} matching local-then-copied bytes`);
    }
  } finally {
    // Best-effort cleanup; never masks the verdict above.
    try {
      if (largeFileId) {
        await client.cancelLargeFile(apiUrl, authToken, { fileId: largeFileId });
      }
    } catch { /* the server is torn down after this check anyway */ }
    try {
      for (const name of [COMPOSED_OBJECT_NAME, SOURCE_OBJECT_NAME]) {
        const listed = await client.listFileVersions(apiUrl, authToken, {
          bucketId: bucket.bucketId,
          startFileName: name,
          maxFileCount: 10,
        });
        for (const version of listed.files ?? []) {
          if (version.fileName !== name) continue;
          await client.deleteFileVersion(apiUrl, authToken, {
            fileName: version.fileName,
            fileId: version.fileId,
          }).catch(() => {});
        }
      }
      await client.deleteBucket(apiUrl, authToken, { accountId: auth.accountId, bucketId: bucket.bucketId });
    } catch { /* the server is torn down after this check anyway */ }
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    say(`FAIL (harness -- ${redact(error)})`);
    process.exitCode = 1;
  },
);
