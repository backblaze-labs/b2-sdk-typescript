# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
