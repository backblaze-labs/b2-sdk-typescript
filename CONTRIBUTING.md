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
| `pnpm lint` | Check formatting + lint rules (Biome) |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm typecheck` | Run `tsc --noEmit` with full strictness |

## Before submitting a PR

1. `pnpm typecheck` passes with zero errors
2. `pnpm test` passes with all tests green
3. `pnpm lint` passes with no errors
4. If you added a new public API, add a test using the `B2Simulator`
5. If you added a new B2 endpoint, add it to the `RawClient` in `src/raw/index.ts` and wire it into the simulator if feasible

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
  types/         Pure type definitions (no runtime code)
  errors/        Error hierarchy: B2Error base + subclasses + classifyError()
  http/          Transport layer: HttpTransport interface, fetch wrapper, retry middleware
  raw/           RawClient: 1:1 bindings for all 37 B2 native API endpoints
  auth/          AccountInfo (auth state), upload URL pool, realm URLs
  streams/       SHA1 hashing, ContentSource adapters, progress tracking
  upload/        Small file + large file (multipart) upload orchestration
  download/      Single + parallel ranged download
  simulator/     In-memory B2 server for testing
  client.ts      B2Client: high-level facade over RawClient
  bucket.ts      Bucket: operations scoped to a bucket
  object.ts      B2Object: operations scoped to a file name
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
