# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — security

- **SSRF / URL-substitution guard** in the default `FetchTransport`. After `B2Client.authorize()`, the transport rejects any URL whose host falls outside the realm's parent domain (`backblazeb2.com`, `backblaze.com`) plus user-supplied allow-list entries. Literal IPv4/IPv6 addresses, `localhost`, `metadata.google.internal`, `*.internal`, and `*.local` are rejected unconditionally. New `B2SsrfError` (non-retryable, attaches the offending URL). New public `UrlGuard` class and `deriveAllowedSuffixes()` helper exported from the main entry. Of 29 audited B2 packages in the npm ecosystem, none ship SSRF protection. See [SSRF guard](README.md#ssrf-guard).
- **`B2ClientOptions.allowedHostSuffixes`** — optional extra hosts merged into the guard's allow-list after authorize, for self-hosted proxies / debugging.
- **Audit-derived regression tests** anchored to specific ecosystem failure modes:
  - `src/upload/resume.safety.node.test.ts` fails if the resume module ever imports `node:fs` (prevents s3up-style on-disk uploadId leak).
  - Concurrency invariants on `UploadUrlPool` (no double-issue, evict-on-held safety, key isolation, 1000-cycle stress).
  - Monotonicity assertion on `onProgress` event sequences during multipart uploads.

### Added — source-level isomorphism

- **`.ts` extensions on every internal relative import.** `tsconfig.json` enables `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. One source tree now runs unmodified in Node 22+, Bun, Deno (no build step, no `node_modules`, no `npm:` shim), browsers, Cloudflare Workers, and Vercel Edge. Vite rewrites the extensions during build so consumers still see `./foo.js` in dist/.
- **Deno typecheck workflow** verifies the property on every push: `deno check examples/...` resolves `@backblaze/b2-sdk` straight at `../src/*.ts` via `examples/deno.json`. If a `.js` extension ever sneaks back into an internal import, the workflow fails immediately.
- **JSON-imported version constant.** `src/version.ts` does `import pkg from '../package.json' with { type: 'json' }; export const VERSION = pkg.version`. Bumping the package version automatically propagates to the User-Agent header and the published artifact — no separate `src/version.ts` to maintain, no sync script. Rollup tree-shakes the JSON down to a 133-byte module containing only the version field; no devDependency or metadata leak to consumers.

### Added — telemetry & identity

- **Stable, greppable User-Agent.** Format: `b2-sdk-ts/<version> (typescript; @backblaze/b2-sdk; <runtime>; [os; ][arch])`. Both `b2-sdk-ts/` (stable product token) and `@backblaze/b2-sdk` (npm package name) are part of the documented contract — log queries can match either. Runtime detection covers Node, Bun, Deno, and browser; OS + arch reported on non-browser runtimes. Custom `userAgent` from `B2ClientOptions` is prepended verbatim. New exported constants `SDK_PRODUCT` and `SDK_PACKAGE` from `@backblaze/b2-sdk`.

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
- **`bucket.getFileInfoByName(fileName)`** and **`bucket.unhide(fileName)`** convenience methods.
- **`FileAccountInfo`** — JSON-file-backed `AccountInfo` (Node-only) under new subpath `@backblaze/b2-sdk/auth/file`. Survives process restart; load() returns silently on missing/corrupt files.

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
