# Contributing to @backblaze/b2-sdk

We welcome contributions. This document covers setup, conventions, and the PR workflow.

## Prerequisites

- **Node.js 22+** (check with `node --version`)
- **pnpm 11+** (installed via corepack: `corepack enable && corepack prepare pnpm@11.1.0 --activate`)

## Development setup

```bash
git clone https://github.com/backblaze/b2-sdk-typescript.git
cd b2-sdk-typescript
pnpm install
pnpm build
pnpm test
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm build` | Build ESM + CJS + DTS via Vite library mode |
| `pnpm test` | Run tests (Vitest, uses in-memory simulator) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with v8 coverage report (target ≥ 95% statements) |
| `pnpm test:browser` | Run the test suite in real Chromium/Firefox/WebKit via Playwright |
| `pnpm lint` | Check formatting + lint rules (Biome, `--error-on-warnings` — any warning fails) |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm lint:docs` | Check JSDoc / TSDoc completeness with ESLint |
| `pnpm typecheck` | Run `tsc --noEmit` with full strictness |
| `pnpm typecheck:examples` | Typecheck the cookbook examples against `src/` |
| `pnpm test:integration` | Run integration tests against real B2 (auto-skips without credentials) |
| `pnpm docs` | Generate TypeDoc API documentation under `./docs` |

CI also runs `bun test src/` against the same test suite plus a per-engine browser matrix (Chromium / Firefox / WebKit). Avoid module-level mocking patterns (`vi.mock` with `importOriginal` / `vi.importActual`) that Bun's vitest-compat doesn't support: prefer dependency injection (see `RetryTransport`'s `sleepImpl` option).

### Test file naming convention

| Pattern | Where it runs |
|---|---|
| `**/*.test.ts` | Both Node (`pnpm test`) and Browser (`pnpm test:browser`) |
| `**/*.node.test.ts` | Node only. Anything that imports `node:fs`, `node:os`, `node:util`, OS keychain, etc. |

If a single test inside a shared file is Node-only (e.g. uses `node:util.inspect`), gate it with `it.skipIf(...)`:

```ts
const isNode = typeof (globalThis as Record<string, unknown>)['process'] !== 'undefined'
it.skipIf(!isNode)('uses node:util.inspect', () => { ... })
```

One-time local browser setup: `pnpm exec playwright install chromium firefox webkit`. CI caches the binaries.

## Before submitting a PR

1. `pnpm typecheck` passes with zero errors
2. `pnpm typecheck:examples` passes with zero errors
3. `pnpm test` passes with all tests green
4. `pnpm test:coverage` keeps coverage at or above 95% statements
5. `pnpm lint` and `pnpm lint:docs` both pass with **zero warnings** (the `lint` script uses `--error-on-warnings`)
6. `pnpm docs` runs cleanly (TypeDoc treats warnings as errors)
7. If you added a new public API, add a test using the `B2Simulator`
8. If you added a new B2 endpoint, add it to the `RawClient` in `src/raw/index.ts` and wire it into the simulator if feasible
9. If you added a new exported type used in any public method signature, re-export it from `src/index.ts` (TypeDoc fails the docs job otherwise)
10. If you added a new internal relative import, use the `.ts` extension (`import { x } from './foo.ts'`). The Deno typecheck job in `.github/workflows/examples.yml` fails immediately if a `.js` extension slips in.

## Code style

Biome handles formatting. Run `pnpm lint:fix` to auto-format. Key rules:

- 2-space indentation
- Single quotes
- Trailing commas
- 100-character line width
- No semicolons (ASI)
- Imports sorted by Biome's organizeImports

## TypeScript conventions

The project uses maximum TypeScript strictness. Key things to know:

### exactOptionalPropertyTypes

`{ x?: string }` means x is either absent or a `string`. It does NOT accept `undefined`.

```ts
// Wrong: passes undefined explicitly
doThing({ x: maybeUndefined })

// Right: conditionally include the property
doThing({
  ...(maybeUndefined !== undefined ? { x: maybeUndefined } : {}),
})
```

### Branded types

IDs are branded for type safety. Use factory functions:

```ts
import { bucketId, fileId } from './types/ids.js'

const bid = bucketId('raw-string')  // BucketId
const fid = fileId('raw-string')    // FileId
```

### verbatimModuleSyntax

Use `import type` for type-only imports. If you need a class at runtime (e.g., for `instanceof`), use a regular import.

```ts
import type { FileVersion } from './types/file.js'  // type only
import { B2Error } from './errors/index.js'          // used with instanceof
```

## Architecture overview

```
src/
  types/         Pure type definitions (no runtime code) + EncryptionKey class
  errors/        Error hierarchy: B2Error base + 13 subclasses + classifyError() + B2InsufficientCapabilityError
  http/          Transport layer: HttpTransport, FetchTransport, RetryTransport (with injectable sleepImpl)
  raw/           RawClient: 1:1 bindings for all 37 B2 native API endpoints
  auth/          AccountInfo (in-memory + JSON-file backends), upload URL pool, realm URLs
  streams/       SHA1 hashing, ContentSource adapters, progress tracking
  upload/        Single + large-file (multipart) upload, resume.ts, stream.ts (WritableStream sink)
  download/      Single + parallel ranged download (with per-range retry)
  copy/          copyLargeFile orchestrator (server-side multipart copy)
  sync/          synchronize() async generator, LocalFolder + B2Folder scanners, policies, actions
  s3/            S3-compatible helpers (createS3ClientConfig, presignGetObjectUrl)
  simulator/     In-memory B2 server for testing
  client.ts      B2Client: high-level facade over RawClient + hasCapabilities
  bucket.ts      Bucket: operations scoped to a bucket (including deleteMany/deleteAll/copyLargeFile/unhide)
  object.ts      B2Object: operations scoped to a file name (including createReadStream/createWriteStream)
```

### Testing

Tests use the in-memory `B2Simulator` which implements the B2 API at the HTTP level. No network, no mocking frameworks, deterministic.

```ts
const sim = new B2Simulator()
const client = new B2Client({
  applicationKeyId: 'test',
  applicationKey: 'test',
  transport: sim.transport(),
})
await client.authorize()
```

### Adding a new B2 API endpoint

1. Add request/response types to `src/types/` (e.g., `src/types/file.ts`)
2. Add the method to `RawClient` in `src/raw/index.ts`
3. Re-export from `src/types/index.ts` if needed
4. Add handler to `B2Simulator` in `src/simulator/index.ts`
5. Add high-level wrapper to `Bucket`, `B2Object`, or `B2Client` as appropriate
6. Write a test in `src/client.test.ts`

## Commit messages

Use concise commit messages. Focus on the "why" not the "what". Examples:

- `fix upload URL eviction on 408 timeout`
- `add SSE-C header plumbing for download requests`
- `support AbortSignal in parallel download stream`

## Reporting issues

Open an issue at https://github.com/backblaze/b2-sdk-typescript/issues with:

- What you expected
- What happened instead
- Minimal reproduction code
- Node.js version and runtime (Node/Bun/Deno/browser)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
