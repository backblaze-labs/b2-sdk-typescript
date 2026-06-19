# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Downloads now verify whole-file SHA-1 checksums when B2 provides a verifiable digest.** Full-body GET downloads wrap the response stream and throw `ChecksumMismatchError` if the bytes do not match `X-Bz-Content-Sha1`; parallel ranged downloads verify the assembled stream in order and reject cross-range header disagreements. HEAD requests, partial range GETs, and files whose download SHA-1 is unavailable (`none` / `null`) continue to skip verification because no matching whole-body digest exists. Closes #25.
- **`B2Simulator` `b2_copy_file` now honors `metadataDirective`, `contentType`, `fileInfo`, and `range`.** A `COPY` directive (default) preserves the source's content type and file info; `REPLACE` applies the request's (and is rejected with `400 bad_request` when `contentType` is missing, matching real B2, with the supplied `fileInfo` validated). A byte `range` copies only the requested slice and recomputes its SHA-1, rejecting an unsatisfiable range with `416`. Previously the simulator ignored all four and always did a whole-file COPY.
- **Retry transient 5xx responses.** `internal_error` / HTTP 500 (and 502 Bad Gateway, 504 Gateway Timeout) are now classified as retryable, so `RetryTransport` retries them with backoff alongside 408/429/503. Previously a transient 500 surfaced as an immediate, non-retryable failure. 501 Not Implemented remains non-retryable (deterministic). Upload endpoints (`b2_upload_file` / `b2_upload_part`) do not retry retryable failures in place: they are URL-pinned, so upload failures now bubble to the upload layer for fresh-URL recovery.
- **Uploads now retry transient failures with fresh upload URLs.** Single-file uploads, multipart parts, stream-backed multipart uploads, and `createWriteStream()` evict a failed upload URL, back off with one upload retry budget, fetch a fresh upload URL / part URL without nested transport retries, and retry there for 408/429/5xx, stale upload URLs, expired upload tokens, network failures, and lost upload response bodies. `onUploadRetry` reports file name, part number, attempt, delay, and classified error before each retry. If the first upload POST succeeded but the response was lost, a retry can create a duplicate file version; compare returned file IDs and SHA-1 values when reconciling uploads, use `retryResponseBodyFailures: false` to fail instead of re-sending in that case, and use lifecycle or version-retention rules when buckets need automatic cleanup.
- **Correct browser SHA-1 for buffer-backed views.** `sha1Hex`'s WebCrypto path hashed `data.buffer` (the whole backing `ArrayBuffer`) instead of the `Uint8Array` view's `byteOffset`/`byteLength`, so a subarray (e.g. a carved multipart part) produced a wrong digest in browsers and other non-Node runtimes. It now hashes the view directly. (`IncrementalSha1`'s WebCrypto fallback was already correct, since it copies chunks into an exact-sized buffer before hashing; it now passes that buffer directly too, for consistency.) The Node `crypto` path was always correct.
- **`B2Simulator` now verifies upload SHA-1 and persists `fileInfo` across all upload paths.** `b2_upload_file` and `b2_upload_part` recompute the body's SHA-1 and reject a mismatch with `400 bad_request` ("Sha1 did not match data received"), honoring the `none` / `do_not_verify` / `unverified:<hex>` sentinels and the `hex_digits_at_end` trailing-digest mode (the trailing 40 bytes are verified and stripped, not stored as content). `finishLargeFile` verifies each `partSha1Array` entry against the stored part's SHA-1 (rejecting a mismatch with `400 bad_request`). Uploaded `fileInfo` is now persisted for both single-file and multipart (`finishLargeFile`) uploads and returned by `getFileInfo`, list, and `download` (serialized as `X-Bz-Info-*` headers using the same B2 `encodeFileName` encoding the download parser decodes with). Closes gaps where the test backend accepted any hash and silently discarded metadata. `B2Simulator.handleUpload` is now `async`.

## [0.1.0] - 2026-05-28

First public release of `@backblaze-labs/b2-sdk`. Everything below is new in this version.

### Added — security

- **SSRF / URL-substitution guard** in the default `FetchTransport`. After `B2Client.authorize()`, the transport rejects any URL whose host falls outside the realm's parent domain (`backblazeb2.com`, `backblaze.com`) plus user-supplied allow-list entries. Literal IPv4/IPv6 addresses, `localhost`, `metadata.google.internal`, `*.internal`, and `*.local` are rejected unconditionally. New `B2SsrfError` (non-retryable, attaches the offending URL). New public `UrlGuard` class and `deriveAllowedSuffixes()` helper exported from the main entry. See [SSRF guard](README.md#ssrf-guard).
- **`B2ClientOptions.allowedHostSuffixes`** — optional extra hosts merged into the guard's allow-list after authorize, for self-hosted proxies / debugging.
- **Audit-derived regression tests** anchored to specific ecosystem failure modes:
  - `src/upload/resume.safety.node.test.ts` fails if the resume module ever imports `node:fs` (prevents s3up-style on-disk uploadId leak).
  - Concurrency invariants on `UploadUrlPool` (no double-issue, evict-on-held safety, key isolation, 1000-cycle stress).
  - Monotonicity assertion on `onProgress` event sequences during multipart uploads.

### Added — source-level isomorphism

- **`.ts` extensions on every internal relative import.** `tsconfig.json` enables `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. One source tree now runs unmodified in Node 22+, Bun, Deno (no build step, no `node_modules`, no `npm:` shim), browsers, Cloudflare Workers, and Vercel Edge. Vite rewrites the extensions during build so consumers still see `./foo.js` in dist/.
- **Deno typecheck workflow** verifies the property on every push: `deno check examples/...` resolves `@backblaze-labs/b2-sdk` straight at `../src/*.ts` via `examples/deno.json`. If a `.js` extension ever sneaks back into an internal import, the workflow fails immediately.
- **JSON-imported version constant.** `src/version.ts` does `import pkg from '../package.json' with { type: 'json' }; export const VERSION = pkg.version`. Bumping the package version automatically propagates to the User-Agent header and the published artifact — no separate `src/version.ts` to maintain, no sync script. Rollup tree-shakes the JSON down to a 133-byte module containing only the version field; no devDependency or metadata leak to consumers.

### Added — telemetry & identity

- **Stable, greppable User-Agent.** Format: `b2-sdk-typescript/<version> (typescript; @backblaze-labs/b2-sdk; <runtime>; [os; ][arch])`. Both `b2-sdk-typescript/` (stable product token) and `@backblaze-labs/b2-sdk` (npm package name) are part of the documented contract — log queries can match either. Runtime detection covers Node, Bun, Deno, and browser; OS + arch reported on non-browser runtimes. Custom `userAgent` from `B2ClientOptions` is prepended verbatim. New exported constants `SDK_PRODUCT` and `SDK_PACKAGE` from `@backblaze-labs/b2-sdk`.

### Added — simulator fidelity & test seams

- **B2 spec input validation in the simulator.** `validateBucketName`, `validateFileName`, `validateFileInfo`, `validateBucketInfo`, and `validateMaxCount` enforce the limits B2 documents (6-63 char bucket name with `b2-` reserved-prefix rule, 1024-byte UTF-8 file-name cap, 2048-byte fileInfo / bucketInfo budgets, per-endpoint `maxFileCount` ceilings). Wired into every state-touching handler. Limit constants (`BUCKET_NAME_MIN/MAX`, `FILE_NAME_MAX_BYTES`, `FILE_INFO_TOTAL_MAX`, `BUCKET_INFO_MAX_KEYS`, etc.) are re-exported from `@backblaze-labs/b2-sdk/simulator` for tests that want to parameterise around the documented caps.
- **Opt-in strict-auth mode.** `new B2Simulator({ strictAuth: true })` enforces application-key capabilities, bucket scoping, prefix scoping, and auth-token expiry on every request (including upload + download paths). Unknown tokens return `401 bad_auth_token`; expired tokens return `401 expired_auth_token`; missing capabilities return `403 unauthorized`. Default remains permissive so existing tests are unaffected.
- **Virtual clock for expiry tests.** `B2Simulator.advanceTime(ms)` fast-forwards the simulator's internal clock so `authTokenTtlMs` expiry paths can be exercised without `setTimeout`.
- **Pluggable post-upload hooks.** `onWebhookDeliver` fires after every successful upload / copy / `finishLargeFile` against a bucket with matching event-notification rules; `onReplicate` fires when the bucket is a replication source. Errors thrown from user hooks are routed to the optional `onHookError` (otherwise swallowed — a buggy listener never masks API success). `B2Simulator.flushHooks()` is a deterministic test seam: awaits every pending hook to settle before assertions.
- **Wire-level edge cases.** `parseRangeHeader` returns a tagged result (`ok` / `unsatisfiable` / `malformed`); the simulator now returns `206` with the documented `Content-Range: bytes <start>-<end>/<total>` header and `416 Range Not Satisfiable` (with `Content-Range: bytes */<total>`) when the start offset is past EOF. Realistic 24-hex IDs (`b2_bucket_<hex>`, `4_z<hex>`) replace the previous 12-digit stand-in. `b2_finish_large_file` validates `partNumber ∈ [1, 10000]` and that `partSha1Array.length === uploadedParts.length`. `b2_delete_key` evicts every outstanding auth token issued from the revoked key.
- **Fault injection.** `B2Simulator.injectFailure({ on, status, code, message, count, skip, retryAfter })` registers a synthetic failure that fires on every matched request until its `count` budget is spent. Returns a `FaultHandle` whose `.clear()` retires that specific registration. `clearFaults()` removes every fault. Faults run before any real handler, so a matched request never touches in-memory state.

### Added — CI & examples

- **`real-examples` CI job** runs every documented `npx tsx examples/...` command against a real B2 account after the integration suite passes (Node 22 + 24, serialised). The runner asserts content round-trip equality for both `node-download` and `node-backup-cli restore`. A renamed flag, swapped argument order, or stale README command fails CI before reaching users.
- **`smoke-examples` CI job** runs the same examples against an in-memory `B2Simulator` on every push and PR — zero credentials, zero network, zero cost. Exercises the `npx tsx`/`exports`-map resolution path the same way an `npm install`-ed consumer would.
- **Real-B2 integration workflow** (`.github/workflows/integration.yml`) runs the integration suite sequentially across Node 22 + 24 with `max-parallel: 1`, on push, PR, weekly schedule, and `workflow_dispatch`. Defensive `sdk-test-*` bucket sweep at startup absorbs leftovers from crashed runs.
- **Examples Deno + Bun typecheck jobs.** `bunx tsc --noEmit -p examples/tsconfig.json` and `deno check` (via `examples/deno.json` import map) run on every push.

### Changed — lint gate

- **`pnpm lint` now uses `biome check --error-on-warnings`.** Any warning — not just an error — fails CI. The previous 17 baseline warnings (all `lint/suspicious/noExplicitAny` in test mocks) were converted to `as unknown as <RealType>` casts.

### Changed — CI matrix timeouts

- **`LARGE_TEST_TIMEOUT = 60_000`** applied to copy + write-stream tests in `src/copy/copy.test.ts` and `src/upload/stream.test.ts`, matching the existing calibration in `src/upload/upload.test.ts`. macOS GitHub-hosted runners are ~2-3× slower than typical local Macs for the simulator's per-part SHA-1 computation; the previous hardcoded 30 s budget was getting clipped on bad scheduling ticks.

### Added — docs

- **Bundle-size table** in the Quality section, measured per-subpath via Bun's bundler with tree-shaking enabled (main entry: ~9.6 KB gzipped; `/errors`: 670 B gzipped; `/streams`: 801 B gzipped; `/simulator`: 5.3 KB gzipped).
- **Source-isomorphism section** in the README documenting how `deno check examples/` against `src/` works without a build step.
- **Identifying your traffic (User-Agent)** section in the README documents the contract and how to prepend an application prefix.

### Added — isomorphic test coverage

- **Vitest browser-mode test suite** under `pnpm test:browser`. The full test surface (minus `*.node.test.ts` files) runs in real Chromium, Firefox, and WebKit via Playwright. CI parallelizes per engine via `VITEST_BROWSER_INSTANCE`.
- **Isomorphic `B2Simulator`**: `handleRequest` is now `async` and the `b2_copy_part` handler uses the SDK's own `sha1Hex` (Node `node:crypto` lazy-loaded, WebCrypto fallback in browsers). Drops the previous `node:crypto.createHash` top-level import.
- **Pure-JS MD5 fallback** in `EncryptionKey.fromBytes`. When `node:crypto.createHash` isn't available, the SDK computes MD5 in pure JS so SSE-C key construction stays cross-runtime. Verified against three RFC 1321 vectors in both Node and browsers.
- **Lazy `node:fs/promises` and `node:path` imports** inside `src/sync/synchronizer.ts` action closures. The synchronizer module itself loads in browsers (B2-to-B2 sync works in a browser); only local-disk actions throw when invoked outside Node.
- **Test file naming convention**: `*.node.test.ts` is skipped in browser mode. Renamed `src/auth/file.test.ts` → `file.node.test.ts`, `src/sync/scanners/scanners.test.ts` → `scanners.node.test.ts`. Added `src/streams/encryption-key.node.test.ts` for the `util.inspect` redaction assertion.

### Added — robustness

- **Resume support for multipart uploads.** Pass `resume: true` (or an explicit `resumeFileId`) to `uploadLargeFile` or `Bucket.upload`. The engine queries `listUnfinishedLargeFiles` + `listParts` and skips parts whose locally-recomputed SHA-1 matches the server's. New `src/upload/resume.ts` with `findResumeCandidate` and `collectPartSha1s` helpers.
- **Per-range retry in `createParallelDownloadStream`.** Each ranged GET is retried independently with exponential backoff and jitter (default 5 attempts). New `maxRetries` option; a single transient 503 no longer kills the whole transfer.
- **Bulk delete primitives** on `Bucket`:
  - `deleteMany(targets, options?)` — bounded-concurrency delete with per-target error collection
  - `deleteAll({ prefix?, dryRun?, pageSize? })` — async generator that streams `DeleteAllEvent` over every matching file version
- **`bucket.copyLargeFile(options)` orchestrator** (new `src/copy/large.ts`). Server-side multipart copy via `b2_copy_part`. Falls back to single `copyFile` below part-size threshold. Works across buckets.
- **SSE-C key safety helpers.** New `EncryptionKey` class in `src/types/encryption.ts`:
  - `EncryptionKey.fromBytes(rawKey)` computes MD5 internally
  - `EncryptionKey.fromBase64(key, md5)` for browser-precomputed digests
  - Redacts itself in `toJSON()`, `toString()`, and Node's `util.inspect` custom symbol
- **`bypassGovernance` flag** on `bucket.updateFileRetention(..., { bypassGovernance: true })` for shortening governance-mode retention.

### Added — ergonomics

- **`B2Object.createWriteStream(options?)`** returning `{ writable: WritableStream<Uint8Array>, done: Promise<FileVersion> }`. Pipe a `ReadableStream` directly into B2 with multipart-protocol buffering, parallel part uploads, and backpressure.
- **`B2Client.hasCapabilities(needed)`** returns `{ ok, missing }` against `accountInfo.allowed.capabilities`. New `B2InsufficientCapabilityError` (the 13th error subclass) and `CapabilityCheckResult` interface.
- **`bucket.getFileInfoByName(fileName)`** and **`bucket.unhideFile(fileName)`** convenience methods.
- **`FileAccountInfo`** — JSON-file-backed `AccountInfo` (Node-only) under new subpath `@backblaze-labs/b2-sdk/auth/file`. Survives process restart; load() returns silently on missing/corrupt files.

### Added — base

- `B2Client` high-level facade with bucket and key management
- `Bucket` handle: upload, download, list, hide, delete, copy, update, notifications, retention, legal hold
- `B2Object` handle: upload, download, parallel download stream, file info, hide, delete
- `RawClient` with all 37 B2 native API endpoint bindings (including `listParts` and `copyPart` simulator handlers)
- Single-file upload with automatic SHA-1 computation
- Large file (multipart) upload with parallel part uploads, cancellation via `AbortSignal`
- Parallel ranged downloads with ordered chunk reassembly
- Sync engine: `synchronize()` async generator + `LocalFolder` / `B2Folder` scanners + compare/keep policies
- `B2Simulator` in-memory test server (no network required) — now supports `b2_list_parts`, `b2_copy_part`, `b2_update_file_retention`, `b2_update_file_legal_hold`, and monotonic upload timestamps for deterministic version ordering
- Full TypeScript types for all B2 API request/response types
- Branded ID types (`BucketId`, `FileId`, `KeyId`, etc.)
- `B2Error` hierarchy with 13 subclasses and automatic retry classification
- `RetryTransport` with exponential backoff, jitter, `Retry-After` support, automatic reauth, and injectable `sleepImpl` for tests
- `IncrementalSha1` with Node.js `crypto` and WebCrypto `subtle` backends
- `ContentSource` adapters: `BufferSource`, `BlobSource`, `StreamSource`
- Upload URL pool with checkout/checkin/evict pattern
- SSE-B2 and SSE-C encryption support in upload and download paths
- Object lock (file retention) and legal hold support
- Event notification rules (get/set)
- S3-compatible helpers: `createS3ClientConfig`, `presignGetObjectUrl`
- Subpath exports for tree-shaking: `/raw`, `/errors`, `/auth`, `/auth/file`, `/streams`, `/simulator`, `/sync`, `/s3`
- Dual ESM + CJS output via Vite library mode
- Biome for linting and formatting; ESLint with strict JSDoc/TSDoc rules for doc completeness
- TypeDoc for API documentation
- Vitest test suite with 486 tests across 20 files at ≥ 95% statement coverage. Tests run cleanly under both vitest (Node) and Bun's vitest-compat (no module-level mocking required)

[Unreleased]: https://github.com/backblaze-labs/b2-sdk-typescript/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/backblaze-labs/b2-sdk-typescript/releases/tag/v0.1.0
