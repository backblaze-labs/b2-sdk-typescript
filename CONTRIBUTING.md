# Contributing to @backblaze-labs/b2-sdk

We welcome contributions. This document covers setup, conventions, and the PR workflow.

## Prerequisites

- **Node.js ^22.22.2 or >=24.15.0 for full repo checks**; the published SDK runtime supports Node.js 22.3+ (check with `node --version`)
- **pnpm 11+** (installed via corepack: `corepack enable && corepack prepare pnpm@11.1.0 --activate`)

## Development setup

```bash
git clone https://github.com/backblaze-labs/b2-sdk-typescript.git
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
| `pnpm test:known-defects` | Run the known-defect tests in `tests/known-defects/` (they assert correct behaviour that is not implemented yet, so this command exits non-zero until the defects are fixed; it runs `pnpm build` first because the example-program tests spawn the built package). See `tests/known-defects/README.md` |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm test:coverage` | Run tests with v8 coverage report (gates: 97% statements, 98% lines, 97% functions, 92% branches for the SDK; `src/simulator/` has its own gate in `vitest.coverage.config.ts`) |
| `pnpm test:browser` | Run the test suite in real Chromium/Firefox/WebKit via Playwright |
| `pnpm lint` | Check formatting + lint rules (Biome, `--error-on-warnings` — any warning fails) |
| `pnpm lint:fix` | Auto-fix lint and formatting issues |
| `pnpm lint:docs` | Check JSDoc / TSDoc completeness with ESLint |
| `pnpm lint:spelling` | Spell-check comments + docs with CSpell (config: `cspell.config.yaml`, project dictionary: `.cspell/project-words.txt`) |
| `pnpm typecheck` | Run `tsc --noEmit` with full strictness |
| `pnpm typecheck:examples` | Typecheck the cookbook examples against `src/` |
| `pnpm test:integration` | Run integration tests against real B2 (local runs skip without credentials; same-repo CI requires them) |
| `pnpm docs` | Generate TypeDoc API documentation under `./api-docs` |

CI also runs `bun test src/` against the same test suite plus a per-engine browser matrix (Chromium / Firefox / WebKit). Avoid module-level mocking patterns (`vi.mock` with `importOriginal` / `vi.importActual`) that Bun's vitest-compat doesn't support: prefer dependency injection (see `RetryTransport`'s `sleepImpl` option).

### Simulator vs real B2

`pnpm test` uses the in-memory `B2Simulator`: it is fast, deterministic, and
models the SDK's supported wire contract. It is not a promise to preserve every
historical Backblaze B2 behavior. During v3/v4 transition windows, the simulator
should accept both routes only where the SDK intentionally supports both and the
semantics are identical. Deprecated SDK aliases should normalize before they
reach raw calls or simulator routes, and contract tests should make alias versus
canonical behavior explicit.

`pnpm test:integration` is the live Backblaze B2 evidence path. Local runs skip
without `B2_APPLICATION_KEY_ID` and `B2_APPLICATION_KEY` so contributors can work
offline. The GitHub `Integration (real B2)` workflow is stricter for same-repo
pushes, same-repo PRs, weekly scheduled runs, and `workflow_dispatch`: missing
secrets fail the job, while fork PRs skip before secrets are read. The integration
setup logs each live setup step (`authorize`, `list buckets`, stale bucket
cleanup, and test bucket creation) with timings and step-specific timeouts so
credential, permission, cleanup, and network failures are diagnosable.

Release workflow success alone does not prove live B2 integration passed. Before
cutting or trusting a release, confirm that the relevant commit also has a green
`Integration (real B2)` run, or manually dispatch that workflow for the commit.

Raw single-file integration fixtures use `tests/helpers/raw-upload.ts` to follow
[B2's documented upload recovery](https://www.backblaze.com/docs/cloud-storage-upload-files-with-the-native-api):
a 5xx response is retried with a fresh upload URL/token, with at most five
attempts and a 60-second overall deadline. The helper uses the SDK's existing
recovery policy; deterministic request errors and unreadable successful responses
still fail. It logs retry counts/status only. Metadata, encryption and byte
assertions remain in the live tests. Credential-free helper regressions run
with the ordinary Node test suite.

### Tests against the standalone simulator

The tests are moving off the embedded `B2Simulator` onto the standalone
[b2-simulator](https://github.com/backblaze-labs/b2-simulator) server, which
speaks the B2 native API over real HTTP on loopback. Migrated files import
`makeRemoteClient` / `resetRemoteSimulator` from
`src/test-utils/remote-simulator.ts`; the others still use the embedded
simulator until they are migrated.

**Getting the server.** The tests use one pinned b2-simulator commit
(`SIMULATOR_PIN` in `scripts/b2-simulator/pin.mjs`). Fetch it once:

```bash
pnpm run simulator:fetch     # shallow-fetches the pinned commit into node_modules/.cache/b2-simulator/<sha>
```

The script checks that the checkout's `HEAD` is exactly the pinned commit. To
use a local b2-simulator checkout instead (for example while changing the
simulator), set `B2SIM_DIR=/path/to/b2-simulator`; nothing is fetched then.
The b2-simulator repository is private: the fetch uses your git credentials.
CI does not run the fetch; `.github/actions/b2-simulator` checks out the pinned
commit with a read-only deploy key (the `SIMULATOR_DEPLOY_KEY` secret), checks
its revision and passes its path to the test steps as `B2SIM_DIR`. Pull
requests from forks get no secrets, so CI refuses them with a message; push the
branch to this repository instead. `release.yml` checks out the same commit
before it checks out the release commit. To move the pin, change
`SIMULATOR_PIN` and the `ref` in `release.yml` together (a test checks that
they match). Tests never fetch anything; without the server they fail with a
message that names this command.

**Running.** Nothing else changes: `pnpm test`, `pnpm test:slow`,
`pnpm test:coverage`, `pnpm test:browser` and `bun test src/` all run migrated
files. Each test process (each Vitest worker, the Bun process) starts its own
server on first use (`--control --profile ts-sdk`, about 0.1 s), so files that
run at the same time never share one; every `makeRemoteClient` /
`resetRemoteSimulator` call resets that server (`POST /reset`) with the test's
options. The server exits with the test process, even when that process is
killed. In browser mode the page cannot reach the server directly (no CORS,
and the control plane refuses requests with an `Origin`), so requests travel
through Vitest browser commands (`src/test-utils/remote-simulator-commands.ts`)
to one server per browser session and test file.

**Migrating a test file.** Change only how the simulator is created and
driven, never an assertion:

1. Imports: `makeClient` becomes `makeRemoteClient`, and `new B2Simulator(opts)`
   becomes `await resetRemoteSimulator(opts)`, both from
   `./test-utils/remote-simulator.ts`. Drop the `B2Simulator` import.
2. `makeClient(x)` becomes `await makeRemoteClient(x)` with the same argument
   (`simOpts` or `{ sim, client }`); make the enclosing function `async`.
3. A hand-built `new B2Client({ ..., transport })` whose transport is
   `sim.transport()` or wraps it needs `realm: sim.realm`. Recording and
   failing wrappers around `sim.transport()` keep working. Without the realm
   the client would go to production; the transport refuses that.
4. Control calls are async: `await sim.injectFailure(spec)` (its handle's
   `clear()` is async too), `await sim.clearFaults()`,
   `await sim.advanceTime(ms)`, `await sim.expireUploadToken(token)`,
   `await sim.invalidateUploadToken(token)`, `await sim.flushHooks()`.
5. `injectFailure`'s `on` must be a full endpoint name such as
   `b2_upload_part`, not a URL fragment such as `'b2_upload_part?fileId='`;
   only the status/code pairs the server allows are accepted. `advanceTime`
   takes a positive integer (the standalone clock never rewinds).
6. One simulator per test: each `makeRemoteClient` / `resetRemoteSimulator`
   call empties the server, so a second call in the same test wipes the first
   one's buckets and tokens, and the older handle throws when used. Do not use
   `describe.concurrent` / `it.concurrent` in a migrated file.
7. The options `onWebhookDeliver`, `onReplicate`, `onHookError`,
   `partnerGroupsCapabilities` and `partnerBackupCapabilities`, and anything
   that reads the embedded simulator's internals, have no standalone
   equivalent: leave that test on the embedded simulator and record it. The
   harness uses the global `fetch`, so a test that replaces `globalThis.fetch`
   must restore it before it calls the simulator.
8. Run the file in Node, one browser and Bun, for example
   `pnpm exec vitest run src/x.test.ts`,
   `VITEST_BROWSER_INSTANCE=chromium pnpm exec vitest run --config vitest.browser.config.ts src/x.test.ts`
   and `bun test src/x.test.ts`.
9. If a test fails only against the standalone server, do not edit its
   assertion: record the file, the test, the embedded behavior and the
   standalone behavior in the PR (and on the tracking issue), and leave it
   failing or on the embedded simulator. Requests now take real time, so a
   test that synchronizes on "request sent" can observe a different order of
   responses than the in-process simulator ever produced.

### Test file naming convention

| Pattern | Where it runs |
|---|---|
| `**/*.test.ts` | Both Node (`pnpm test`) and Browser (`pnpm test:browser`) |
| `**/*.node.test.ts` | Node only. Anything that imports `node:fs`, `node:os`, `node:util`, OS keychain, etc. |
| `tests/known-defects/*.known-defect.test.ts` | Only `pnpm test:known-defects`. Tests of correct behaviour that currently fails; never part of `pnpm test`, Bun or browser runs |

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
4. `pnpm test:coverage` keeps coverage at or above the configured statement, line, function, and branch thresholds
5. `pnpm lint`, `pnpm lint:docs`, and `pnpm lint:spelling` all pass with **zero warnings** (the `lint` script uses `--error-on-warnings`). If CSpell flags a legitimate term, add it to `.cspell/project-words.txt` rather than inlining `// cspell:ignore`
6. `pnpm docs` runs cleanly (TypeDoc treats warnings as errors)
7. If you added a new public API, add a test using the `B2Simulator`
8. If you added a new B2 endpoint, add it to the `RawClient` in `src/raw/index.ts` and wire it into the simulator if feasible
9. If you added a new exported type used in any public method signature, re-export it from `src/index.ts` (TypeDoc fails the docs job otherwise)
10. If you added a new internal relative import, use the `.ts` extension (`import { x } from './foo.ts'`). The Deno typecheck job in `.github/workflows/examples.yml` fails immediately if a `.js` extension slips in.
11. If you touched docs, or anything docs cite (endpoint/export counts, coverage thresholds, min Node, ADRs), `pnpm run verify:docs-consistency` passes. This guard reconciles markdown claims against ground truth and runs in CI on docs-only changes too, so update the prose in the same PR as the source it describes.
12. Add a changelog fragment for user-facing changes with `pnpm changelog:new` and commit the YAML under `.changes/unreleased/`. Do not edit the generated `CHANGELOG.md`; `pnpm changelog:check` detects drift. Keep unpublished advisory details private. Link the PR to its issue and assign both to the intended `vX.Y.Z` release milestone. See [RELEASE.md](RELEASE.md) for batching, signing-key enrollment, and release gates.

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
import { bucketId, fileId } from './types/ids.ts'

const bid = bucketId('raw-string')  // BucketId
const fid = fileId('raw-string')    // FileId
```

### verbatimModuleSyntax

Use `import type` for type-only imports. If you need a class at runtime (e.g., for `instanceof`), use a regular import.

```ts
import type { FileVersion } from './types/file.ts'  // type only
import { B2Error } from './errors/index.ts'          // used with instanceof
```

## Architecture overview

Architecture decisions that affect public APIs, package layout, authorization,
compatibility, simulator behavior, or security posture are recorded under
[`docs/design-docs/`](docs/design-docs/index.md).

```
src/
  types/         Pure type definitions (no runtime code) + EncryptionKey class
  errors/        Error hierarchy: B2Error base + typed subclasses + classifyError() + B2InsufficientCapabilityError
  http/          Transport layer: HttpTransport, FetchTransport, RetryTransport (with injectable sleepImpl)
  raw/           RawClient: 1:1 bindings for the 31 B2 native API endpoints the SDK uses
  auth/          AccountInfo (in-memory + JSON-file backends), upload URL pool, realm URLs
  streams/       SHA1 hashing, ContentSource adapters, progress tracking
  upload/        Single + large-file (multipart) upload, resume.ts, stream.ts (WritableStream sink)
  download/      Single + parallel ranged download (with per-range retry)
  copy/          copyLargeFile orchestrator (server-side multipart copy)
  sync/          synchronize() async generator, LocalFolder + B2Folder scanners, policies, actions
  notifications/ Webhook signature verification (verifyWebhookSignature, requireValidWebhook)
  s3/            S3-compatible helpers (createS3ClientConfig, presignS3GetObjectUrl, presignS3PutObjectUrl)
  partner/       Partner API: PartnerClient + PartnerRawClient, authorizePartner + PartnerAccountInfo, redaction
  backup/        Computer Backup (bz_): BackupClient + BackupRawClient
  simulator/     In-memory B2 server for testing
  client.ts      B2Client: high-level facade over RawClient + hasCapabilities
  bucket.ts      Bucket: operations scoped to a bucket (including deleteMany/deleteAll/copyLargeFile/unhideFile)
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

Single line, subject only, under 72 characters, with a
[Conventional Commits](https://www.conventionalcommits.org) type prefix
(`fix:` / `feat:` / `docs:` / `test:` / `refactor:` / `chore:` / `ci:` / …). Focus
on the "why" over the "what", and don't add AI-tool attribution trailers. The full
policy lives in [`AGENTS.md`](AGENTS.md). Examples:

- `fix: evict upload URL on 408 timeout`
- `feat: plumb SSE-C headers into download requests`
- `feat: support AbortSignal in the parallel download stream`

## Reporting issues

Open an issue at https://github.com/backblaze-labs/b2-sdk-typescript/issues with:

- What you expected
- What happened instead
- Minimal reproduction code
- Node.js version and runtime (Node/Bun/Deno/browser)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
