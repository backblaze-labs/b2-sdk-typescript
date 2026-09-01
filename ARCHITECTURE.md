# Architecture

Codebase map for `@backblaze-labs/b2-sdk`. Start at [`AGENTS.md`](AGENTS.md) for
the operating rules; this file is the structure and the load-bearing design
decisions. Generated API reference lives under `api-docs/` (`pnpm docs`).

## Package layout — subpath exports

Single npm package with subpath exports:

| Export | Entry | Purpose |
|---|---|---|
| `@backblaze-labs/b2-sdk` | `src/index.ts` | B2Client, Bucket, B2Object (high-level facade) |
| `@backblaze-labs/b2-sdk/raw` | `src/raw/index.ts` | 1:1 wire-protocol bindings for the 31 B2 native API endpoints |
| `@backblaze-labs/b2-sdk/errors` | `src/errors/index.ts` | B2Error base + typed subclasses + `classifyError()` |
| `@backblaze-labs/b2-sdk/auth` | `src/auth/index.ts` | AccountInfo interface, InMemoryAccountInfo, UploadUrlPool, realms |
| `@backblaze-labs/b2-sdk/auth/file` | `src/auth/file.ts` | FileAccountInfo: JSON-file-backed persistent auth (Node-only) |
| `@backblaze-labs/b2-sdk/streams` | `src/streams/index.ts` | IncrementalSha1/Sha256, ContentSource adapters, ProgressTracker, EncryptionKey |
| `@backblaze-labs/b2-sdk/sync` | `src/sync/index.ts` | Local/B2 sync engine: LocalFolder, B2Folder, `synchronize()` |
| `@backblaze-labs/b2-sdk/simulator` | `src/simulator/index.ts` | In-memory B2 server for tests |
| `@backblaze-labs/b2-sdk/notifications` | `src/notifications/index.ts` | Webhook signature verification |
| `@backblaze-labs/b2-sdk/s3` | `src/s3/index.ts` | S3-compatible helpers (config, presign GET/PUT) |
| `@backblaze-labs/b2-sdk/partner` | `src/partner/index.ts` | Partner API: PartnerClient, authorizePartner, PartnerCapability, Region |
| `@backblaze-labs/b2-sdk/backup` | `src/backup/index.ts` | Computer Backup (`bz_`): BackupClient, BackupRawClient |

## Source layout

```
src/
  types/         Branded IDs, DTOs, enums (ids.ts, auth.ts, bucket.ts, file.ts, upload.ts, ...)
  errors/        B2Error hierarchy + classifyError + isTransient + B2InsufficientCapabilityError
  http/          HttpTransport, FetchTransport, RetryTransport (injectable sleepImpl), retry math
  raw/           RawClient (31 native endpoints), B2-specific percent-encoding
  auth/          AccountInfo interface, InMemoryAccountInfo, FileAccountInfo, UploadUrlPool, realms
  streams/       IncrementalSha1/Sha256, ContentSource adapters, EncryptionKey
  upload/        uploadSmallFile, uploadLargeFile (multipart + resume), createWriteStream, concurrency
  download/      downloadById/ByName, parallel ranged downloads with per-range retry
  copy/          copyLargeFile orchestrator (server-side multipart copy via b2_copy_part)
  sync/          synchronize() async generator + LocalFolder + B2Folder scanners
  notifications/ Webhook signature verification (verifyWebhookSignature, requireValidWebhook)
  s3/            S3-compatible helpers (createS3ClientConfig, presignS3GetObjectUrl, presignS3PutObjectUrl)
  partner/       PartnerClient + PartnerRawClient, authorizePartner + PartnerAccountInfo, reserve-trial + redaction
  backup/        BackupClient + BackupRawClient (Computer Backup bz_ endpoints)
  simulator/     B2Simulator + SimulatorTransport for testing
  client.ts      B2Client high-level facade + hasCapabilities + CapabilityCheckResult
  bucket.ts      Bucket: upload/download/head/list/copy/copyLargeFile/deleteMany/deleteAll/unhideFile/...
  object.ts      B2Object: upload, download, head, createReadStream, createWriteStream, getFileInfo
  internal/      Shared internals (b2-naming, url-redaction, upload-retry-options)
  util/          Small helpers (abort, best-effort, bytes, crypto, defaults, error-reason, ...)
  index.ts       Public API re-exports
  version.ts     VERSION constant + release-channel resolver
```

## TypeScript strictness

Maximum strictness is on. Common pitfalls:

1. **`noUncheckedIndexedAccess`** — array/object index access returns `T | undefined`. Handle it.
2. **`exactOptionalPropertyTypes`** — `{ x?: string }` means x is absent OR string, NOT undefined. Don't pass `{ x: undefined }`; use conditional spread.
3. **`verbatimModuleSyntax`** — type-only imports use `import type`; value imports for runtime use.

## Key design decisions

- **Branded types** for IDs (BucketId, FileId, …) via a unique-symbol pattern. Use factory functions like `bucketId("string")`.
- **Source-level isomorphism.** Internal relative imports use **`.ts` extensions**, not `.js`. `tsconfig.json` has `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`; Vite rewrites them so consumers see `./foo.js` in `dist/`. **Never write `.js` in an internal import** — the Deno typecheck job in `.github/workflows/examples.yml` fails immediately.
- **No top-level await.** The `node:crypto` import in `streams/hash.ts` uses lazy async init (CJS has no TLA). `IncrementalSha1.update()` returns `Promise<void>`; always `await` it.
- **Web Streams everywhere.** Downloads return `ReadableStream<Uint8Array>`; `B2Object.createWriteStream` returns a `WritableStream<Uint8Array>`; the simulator wraps responses in ReadableStream.
- **Upload URL pool** with checkout/checkin/evict (mirrors the Python SDK). URLs are recycled across requests, evicted on error.
- **RetryTransport** wraps any HttpTransport: 401 reauth, 503/408/429 backoff with jitter, Retry-After, network errors. The `sleepImpl` option lets tests inject a no-op sleep (portable across Vitest and Bun's vitest-compat, which lacks `vi.mock`'s `importOriginal`/`importActual`).
- **Resume support** for multipart uploads: `resume: true` for bounded same-name discovery, or an explicit `resumeFileId`. See `src/upload/resume.ts`.
- **Per-range retry** for parallel downloads. `createParallelDownloadStream` retries each range independently (default 5 attempts) so one transient 503 doesn't kill the transfer.
- **SSE-C key safety.** `EncryptionKey.fromBytes(rawKey)` computes MD5 internally and **redacts itself** in `toJSON()`, `toString()`, and Node's `util.inspect` symbol so the key never lands in logs. `EncryptionKey.generate()` mints a random key.
- **Simulator monotonic timestamps.** The simulator emits strictly-increasing `uploadTimestamp` values so version ordering is deterministic (`Date.now()` ties broke version selection).
- **No module-level test mocking.** Tests use dependency injection, not `vi.mock` factories with `importOriginal`/`importActual` (behave differently across Vitest and Bun).
- **`expect(promise).rejects`, never `expect(asyncFn).rejects`.** Bun's matcher needs an already-running promise. Wrap `for await` assertions in an invoked IIFE. `bun test src/` catches regressions.
- **`createWriteStream().done` has an internal no-op `.catch`.** `src/upload/stream.ts` attaches `done.catch(() => {})` right after `Promise.withResolvers()` so a `done` rejecting before the caller observes it never becomes a process-level unhandled rejection (Bun/Node strict-mode flag the microtask window). The error is not swallowed — `close()`/`abort()` also reject, and a later `await done` still sees it. Don't remove it.
- **Isomorphic simulator.** `B2Simulator.handleRequest` is `async` so the `b2_copy_part` handler can use the SDK's own `sha1Hex` (lazy `node:crypto`, WebCrypto fallback). This is why the whole suite runs in browsers.
- **Sync engine fs imports are lazy.** `src/sync/synchronizer.ts` imports `node:fs/promises` + `node:path` via `await import(...)` inside the action closures, so the synchronizer loads in browsers (B2-to-B2 sync works there); only local-disk actions throw off-Node.
- **SSRF guard on the default transport.** `FetchTransport` calls `urlGuard.check(url)` before every `fetch`. `B2Client.authorize()` locks the guard to host suffixes from the realm's authorize response (+ `backblaze.com` for upload pods). Custom transports (e.g. the simulator) bypass by design. Throws non-retryable `B2SsrfError`. See `src/http/url-guard.ts`.
- **User-Agent contract.** Format: `b2-sdk-typescript/<version-or-dev> (typescript; @backblaze-labs/b2-sdk; <runtime>; [os; ][arch])`. `b2-sdk-typescript/` and `@backblaze-labs/b2-sdk` are stable product tokens — do not rename without coordinating. See `src/http/user-agent.ts`. `src/version.ts` is the only file importing `package.json` (`import pkg from '../package.json' with { type: 'json' }`), re-exported as semver string `VERSION`, and the publish path injects the positive release-channel signal so only stable published builds advertise the semver in the product token.
- **`LARGE_TEST_TIMEOUT = 60_000`** for any test round-tripping multi-MB through the simulator + per-part SHA-1 (`src/upload/upload.test.ts`, `src/copy/copy.test.ts`, `src/upload/stream.test.ts`). macOS runners are ~2-3× slower; 30 s is too tight.

## Native API v4

SDK-built native storage URLs use `/b2api/v4` via one centralized policy in the
raw URL builder (no per-call version param). Partner group-management is `v4`,
Partner authorize is `v3`, Computer Backup is `api/backup/v1`. See
[`MIGRATION.md`](MIGRATION.md) and [`docs/design-docs/`](docs/design-docs/) for the
migration history and docs-drift guardrails.
