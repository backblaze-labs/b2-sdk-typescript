# CLAUDE.md

Instructions for AI assistants working on `@backblaze/b2-sdk`.

## Project overview

Official Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript. Isomorphic (Node 22+, browsers, Bun, Deno, Cloudflare Workers, Vercel Edge). Zero runtime dependencies in core. Built with Vite library mode + Vitest.

## Commands

```bash
pnpm build           # Vite library mode: ESM + CJS + DTS for all 9 subpath exports
pnpm test            # Vitest: runs src/**/*.test.ts against the in-memory B2Simulator (Node)
pnpm test:watch      # Vitest in watch mode
pnpm test:coverage   # Vitest with v8 coverage (target: ≥ 95% statements)
pnpm test:browser    # Vitest browser mode: real Chromium/Firefox/WebKit via Playwright
pnpm lint            # Biome: lint + format check
pnpm lint:fix        # Biome: auto-fix
pnpm lint:docs       # ESLint JSDoc/TSDoc strict checks
pnpm lint:spelling   # CSpell: comments + docs (config: cspell.config.yaml, dict: .cspell/project-words.txt)
pnpm typecheck       # tsc --noEmit (strict + exactOptionalPropertyTypes)
pnpm docs            # Generate TypeDoc API docs under ./docs
pnpm clean           # rm -rf dist docs
```

CI runs all of these on Linux + Windows + macOS (Node 22 and 24 on each) plus `bun test src/` (Bun's vitest-compat), a per-engine `test:browser` matrix (Chromium / Firefox / WebKit), and a coverage gate that fails if statements drop below 95% (configured in `vite.config.ts`'s `coverage.thresholds`).

## Test file naming convention

| Pattern | Where it runs |
|---|---|
| `**/*.test.ts` | Both Node (`pnpm test`) and Browser (`pnpm test:browser`) |
| `**/*.node.test.ts` | Node only. Use for tests that touch `node:fs`, `node:os`, `node:util`, OS keychain, or anything else without a browser analogue |

Browser tests run in real Chromium, Firefox, and WebKit via Playwright. Set `VITEST_BROWSER_INSTANCE=chromium|firefox|webkit` to restrict a local run to a single engine (CI matrix shards this way). One-time setup after `pnpm install`: `pnpm exec playwright install chromium firefox webkit`.

## Architecture

Single npm package with subpath exports:

| Export | Entry | Purpose |
|---|---|---|
| `@backblaze/b2-sdk` | `src/index.ts` | B2Client, Bucket, B2Object (high-level facade) |
| `@backblaze/b2-sdk/raw` | `src/raw/index.ts` | 1:1 wire-protocol bindings for the 31 B2 native API endpoints the SDK exposes |
| `@backblaze/b2-sdk/errors` | `src/errors/index.ts` | B2Error base + 13 subclasses + classifyError() |
| `@backblaze/b2-sdk/auth` | `src/auth/index.ts` | AccountInfo interface, InMemoryAccountInfo, UploadUrlPool, realms |
| `@backblaze/b2-sdk/auth/file` | `src/auth/file.ts` | FileAccountInfo: JSON-file-backed persistent auth (Node-only) |
| `@backblaze/b2-sdk/streams` | `src/streams/index.ts` | IncrementalSha1, ContentSource adapters, ProgressTracker, EncryptionKey |
| `@backblaze/b2-sdk/sync` | `src/sync/index.ts` | Local/B2 sync engine: LocalFolder, B2Folder, synchronize() |
| `@backblaze/b2-sdk/simulator` | `src/simulator/index.ts` | In-memory B2 server for tests |
| `@backblaze/b2-sdk/notifications` | `src/notifications/index.ts` | Webhook signature verification: `verifyWebhookSignature`, `requireValidWebhook`, `B2_WEBHOOK_SIGNATURE_HEADER` |
| `@backblaze/b2-sdk/s3` | `src/s3/index.ts` | S3-compatible helpers: createS3ClientConfig, presignGetObjectUrl |

## Source layout

```
src/
  types/         Branded IDs, DTOs, enums (ids.ts, auth.ts, bucket.ts, file.ts, upload.ts, ...)
  errors/        B2Error hierarchy + classifyError + isTransient + B2InsufficientCapabilityError
  http/          HttpTransport, FetchTransport, RetryTransport (injectable sleepImpl), retry math
  raw/           RawClient (31 native endpoints), B2-specific percent-encoding
  auth/          AccountInfo interface, InMemoryAccountInfo, FileAccountInfo, UploadUrlPool, realms
  streams/       IncrementalSha1 (Node crypto / WebCrypto), ContentSource adapters, EncryptionKey
  upload/        uploadSmallFile, uploadLargeFile (multipart + resume), createWriteStream, concurrency
  download/      downloadById/ByName, parallel ranged downloads with per-range retry
  copy/          copyLargeFile orchestrator (server-side multipart copy via b2_copy_part)
  sync/          synchronize() async generator + LocalFolder + B2Folder scanners
  s3/            S3-compatible helpers (createS3ClientConfig, presignGetObjectUrl)
  simulator/     B2Simulator + SimulatorTransport for testing
  client.ts      B2Client high-level facade + hasCapabilities + CapabilityCheckResult
  bucket.ts      Bucket: upload/download/head/list/copy/copyLargeFile/deleteMany/deleteAll/unhideFile/...
  object.ts      B2Object: upload, download, head, createReadStream, createWriteStream, getFileInfo
  index.ts       Public API re-exports
  version.ts     VERSION constant
```

## Key design decisions

- **exactOptionalPropertyTypes** is ON. Never pass `undefined` where a type says `prop?: T`. Use conditional spread: `...(val !== undefined ? { key: val } : {})`.
- **Branded types** for IDs (BucketId, FileId, etc.) via unique symbol pattern. Use factory functions like `bucketId("string")` to create them.
- **No top-level await.** The `node:crypto` import in `streams/hash.ts` uses lazy async initialization. CJS doesn't support TLA.
- **IncrementalSha1.update() is async** (returns `Promise<void>`) because it awaits lazy init of the Node crypto backend. Always `await sha1.update(data)`.
- **verbatimModuleSyntax** is ON. Use `import type` for type-only imports. Use value imports for anything used at runtime (including `instanceof` checks).
- **Source-level isomorphism.** Internal relative imports use **`.ts` extensions**, not `.js` (`import { x } from './foo.ts'`). `tsconfig.json` has `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`. Vite rewrites the extensions during build so consumers still see `./foo.js` in dist/. **Never write `.js` in an internal import** — the Deno typecheck job in `.github/workflows/examples.yml` fails immediately if one slips in.
- **Web Streams everywhere.** Downloads return `ReadableStream<Uint8Array>`. `B2Object.createWriteStream` returns a `WritableStream<Uint8Array>` for pipeTo-style uploads. The simulator wraps responses in ReadableStream.
- **Upload URL pool** with checkout/checkin/evict pattern (mirrors Python SDK). URLs are recycled across requests, evicted on error.
- **RetryTransport** wraps any HttpTransport. Handles 401 reauth, 503/408/429 backoff with jitter, Retry-After header, network errors. The `sleepImpl` option lets tests inject a no-op sleep for portability across vitest and Bun's vitest-compat (which doesn't support `vi.mock`'s `importOriginal` / `vi.importActual`).
- **Resume support** for multipart uploads: pass `resume: true` (or an explicit `resumeFileId`) to `uploadLargeFile` / `Bucket.upload`. The engine queries `listUnfinishedLargeFiles` + `listParts` and skips parts whose locally-recomputed SHA-1 matches the server's. See `src/upload/resume.ts`.
- **Per-range retry** for parallel downloads. `createParallelDownloadStream` retries each range independently with exponential backoff (default 5 attempts) so a single transient 503 doesn't kill the whole transfer.
- **SSE-C key safety.** `EncryptionKey.fromBytes(rawKey)` computes MD5 internally and **redacts itself** in `toJSON()`, `toString()`, and Node's `util.inspect` custom symbol so the key never lands in logs.
- **Simulator monotonic timestamps.** The simulator generates strictly-increasing `uploadTimestamp` values so version ordering is deterministic in tests (Date.now() ties broke version selection).
- **No module-level test mocking.** Tests use dependency injection instead of `vi.mock` factories with `importOriginal` / `importActual`, which behave differently across vitest and Bun.
- **Isomorphic simulator.** `B2Simulator.handleRequest` is `async` so the `b2_copy_part` handler can use the SDK's own `sha1Hex` (Node `node:crypto` lazy-loaded, WebCrypto fallback in browsers). This is why the entire test suite runs in browsers too.
- **Sync engine fs imports are lazy.** `src/sync/synchronizer.ts` imports `node:fs/promises` and `node:path` via `await import(...)` *inside* the action closures, not at the module top level. Means the synchronizer loads in browsers (B2-to-B2 sync works in a browser); only the local-disk actions throw when invoked in a non-Node runtime.
- **SSRF guard on the default transport.** `FetchTransport` calls `urlGuard.check(url)` before every `fetch`. `B2Client.authorize()` locks the guard to host suffixes derived from the realm's authorize response (plus `backblaze.com` for upload-pod hostnames). Custom transports (e.g. the simulator's) bypass the guard by design — the user owns hardening when they supply their own. Throws non-retryable `B2SsrfError`. See `src/http/url-guard.ts`.
- **User-Agent contract.** Format: `b2-sdk-ts/<version> (typescript; @backblaze/b2-sdk; <runtime>; [os; ][arch])`. Both `b2-sdk-ts/` and `@backblaze/b2-sdk` are stable product tokens — do NOT rename without coordinating. See `src/http/user-agent.ts`. The version lives in `src/version.ts`, which is the only file that imports `package.json` via `import pkg from '../package.json' with { type: 'json' }` and re-exports it as the `VERSION` constant.
- **Lint gate is `--error-on-warnings`.** `pnpm lint` fails CI on any biome warning, not just errors. Prefer `as unknown as T` casts over `as any` in tests.
- **`LARGE_TEST_TIMEOUT = 60_000`** for any test that round-trips multi-MB through the simulator + per-part SHA-1 hashing (`src/upload/upload.test.ts`, `src/copy/copy.test.ts`, `src/upload/stream.test.ts`). macOS GitHub runners are ~2-3× slower than local for this workload; 30 s is too tight.

## TypeScript strictness

The tsconfig enables maximum strictness. Common pitfalls:

1. `noUncheckedIndexedAccess`: array/object index access returns `T | undefined`. Handle it.
2. `exactOptionalPropertyTypes`: `{ x?: string }` means x is absent OR string, NOT undefined. Don't pass `{ x: undefined }`.
3. `verbatimModuleSyntax`: type-only imports must use `import type`. Value imports for runtime use.

## Testing

Tests use the in-memory `B2Simulator` (no network). Create a simulator, get its transport, pass to `B2Client`:

```ts
const sim = new B2Simulator()
const client = new B2Client({
  applicationKeyId: 'test-key-id',
  applicationKey: 'test-key',
  transport: sim.transport(),
})
await client.authorize()
```

Integration tests (real B2) are gated on `B2_APPLICATION_KEY_ID` + `B2_APPLICATION_KEY` env vars.

## Formatting

Biome handles formatting and linting. 2-space indent, single quotes, trailing commas, 100-char line width. Run `pnpm lint:fix` before submitting.

## User-facing docs policy

`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `examples/**/README.md`, and any other doc shipped to npm or rendered on the repo's landing page are **for users**, not for marketing or internal scorecards. When editing these files:

- **No comparisons that name or shame competing packages.** Don't list "X of 29 npm packages ship without Y" or single out `backblaze-b2`, `s3mini`, `storage-abstraction`, etc. as cautionary tales. Readers came here to use *this* SDK, not to hear about anyone else.
- **No internal quality scorecards.** Coverage percentages, runtime matrices, test counts, lint-gate semantics, "this SDK is held to standards most aren't" — that's contributor / maintainer signal. It belongs in `CONTRIBUTING.md`, `CHANGELOG.md`, the CI workflow files, or this `CLAUDE.md` — not in the user-facing README.
- **Describe what the SDK does, how to use it, and what to watch out for**, in that order. If a section's primary purpose is to make us look good rather than help a user complete a task, cut it.

If you find yourself reaching for "by comparison", "of N audited packages", "most other SDKs don't", or a coverage / test-count badge inside a usage doc, stop and put it somewhere internal.

## Git policy

Do not run `git add`, `git commit`, `git push`, `git rebase`, `gh pr create`, or any command that mutates git history unless the user explicitly asks for that specific action in the current turn. Edit files freely; suggest commands the user could run.
