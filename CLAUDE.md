# CLAUDE.md

Instructions for AI assistants working on `@backblaze/b2-sdk`.

## Project overview

Official Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript. Isomorphic (Node 22+, browsers, Bun, Deno, Cloudflare Workers, Vercel Edge). Zero runtime dependencies in core. Built with Vite library mode + Vitest.

## Commands

```bash
pnpm build          # Vite library mode: ESM + CJS + DTS for all 8 subpath exports
pnpm test           # Vitest: runs src/**/*.test.ts against the in-memory B2Simulator
pnpm test:watch     # Vitest in watch mode
pnpm lint           # Biome: lint + format check
pnpm lint:fix       # Biome: auto-fix
pnpm typecheck      # tsc --noEmit (strict + exactOptionalPropertyTypes)
pnpm clean          # rm -rf dist
```

## Architecture

Single npm package with subpath exports:

| Export | Entry | Purpose |
|---|---|---|
| `@backblaze/b2-sdk` | `src/index.ts` | B2Client, Bucket, B2Object (high-level facade) |
| `@backblaze/b2-sdk/raw` | `src/raw/index.ts` | 1:1 wire-protocol bindings for all 37 B2 native API endpoints |
| `@backblaze/b2-sdk/errors` | `src/errors/index.ts` | B2Error base + 12 subclasses + classifyError() |
| `@backblaze/b2-sdk/auth` | `src/auth/index.ts` | AccountInfo interface, InMemoryAccountInfo, UploadUrlPool, realms |
| `@backblaze/b2-sdk/streams` | `src/streams/index.ts` | IncrementalSha1, ContentSource adapters, ProgressTracker |
| `@backblaze/b2-sdk/sync` | `src/sync/index.ts` | Sync engine (stub, M9) |
| `@backblaze/b2-sdk/simulator` | `src/simulator/index.ts` | In-memory B2 server for tests |
| `@backblaze/b2-sdk/s3` | `src/s3/index.ts` | S3-compatible wrapper (stub, M10) |

## Source layout

```
src/
  types/         Branded IDs, DTOs, enums (ids.ts, auth.ts, bucket.ts, file.ts, upload.ts, ...)
  errors/        B2Error hierarchy + classifyError + isTransient
  http/          HttpTransport interface, FetchTransport, RetryTransport, retry math, user-agent
  raw/           RawClient (all 37 endpoints), B2-specific percent-encoding
  auth/          AccountInfo interface, InMemoryAccountInfo, UploadUrlPool, realm URLs
  streams/       IncrementalSha1 (Node crypto / WebCrypto), ContentSource (Blob/Buffer/Stream), progress
  upload/        uploadSmallFile, uploadLargeFile (multipart), Semaphore concurrency
  download/      downloadById/ByName, parallel ranged downloads
  copy/          Server-side copy (stub)
  sync/          Sync engine (stub)
  s3/            S3-compatible wrapper (stub)
  simulator/     B2Simulator + SimulatorTransport for testing
  client.ts      B2Client high-level facade
  bucket.ts      Bucket handle
  object.ts      B2Object handle
  index.ts       Public API re-exports
  version.ts     VERSION constant
```

## Key design decisions

- **exactOptionalPropertyTypes** is ON. Never pass `undefined` where a type says `prop?: T`. Use conditional spread: `...(val !== undefined ? { key: val } : {})`.
- **Branded types** for IDs (BucketId, FileId, etc.) via unique symbol pattern. Use factory functions like `bucketId("string")` to create them.
- **No top-level await.** The `node:crypto` import in `streams/hash.ts` uses lazy async initialization. CJS doesn't support TLA.
- **IncrementalSha1.update() is async** (returns `Promise<void>`) because it awaits lazy init of the Node crypto backend. Always `await sha1.update(data)`.
- **verbatimModuleSyntax** is ON. Use `import type` for type-only imports. Use value imports for anything used at runtime (including `instanceof` checks).
- **Web Streams everywhere.** Downloads return `ReadableStream<Uint8Array>`. The simulator wraps responses in ReadableStream.
- **Upload URL pool** with checkout/checkin/evict pattern (mirrors Python SDK). URLs are recycled across requests, evicted on error.
- **RetryTransport** wraps any HttpTransport. Handles 401 reauth, 503/408/429 backoff with jitter, Retry-After header, network errors.

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

## Git policy

Do not run `git add`, `git commit`, `git push`, `git rebase`, `gh pr create`, or any command that mutates git history unless the user explicitly asks for that specific action in the current turn. Edit files freely; suggest commands the user could run.
