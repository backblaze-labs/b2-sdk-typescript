# AGENTS.md

Single source of truth for AI agents working on `@backblaze-labs/b2-sdk`.
`CLAUDE.md` and `GEMINI.md` point here — **edit this file, not those**.

This is a map, not a manual. Follow the pointers to the real source of truth.

## Repository map

| Where | What |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Subpath exports, source layout, layering, and the key design decisions. **Read before touching `src/`.** |
| [`docs/`](docs/README.md) | **System of record.** [core beliefs](docs/design-docs/core-beliefs.md), [design-docs/ADRs](docs/design-docs/index.md), [quality score](docs/QUALITY_SCORE.md), [exec-plans + tech-debt](docs/exec-plans/tech-debt-tracker.md), [references](docs/references/). |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Dev workflow, PR checklist, release steps. |
| [`CHANGELOG.md`](CHANGELOG.md) / [`MIGRATION.md`](MIGRATION.md) | Keep-a-Changelog history / v3→v4 upgrade guide. |
| `api-docs/` | Generated TypeDoc reference (`pnpm docs`; not versioned). |
| [`README.md`](README.md) | User-facing docs — governed by the docs policy below. |

## Overview

Official Backblaze B2 Cloud Storage SDK for TypeScript/JavaScript. Isomorphic
(Node 22.3+, browsers, Bun, Deno, Cloudflare Workers, Vercel Edge). Zero runtime
dependencies in core. Built with Vite library mode + Vitest.

## Commands

```bash
pnpm build           # Vite library mode: ESM + CJS + DTS for all 12 export entries
pnpm test            # Vitest: src/**/*.test.ts against the in-memory B2Simulator (Node)
pnpm test:watch      # Vitest in watch mode
pnpm test:coverage   # Vitest v8 coverage (gates: 97% statements, 98% lines, 97% functions, 92% branches)
pnpm test:browser    # Vitest browser mode: real Chromium/Firefox/WebKit via Playwright
pnpm lint            # Biome lint + format check (gate is --error-on-warnings)
pnpm lint:fix        # Biome auto-fix
pnpm lint:docs       # ESLint JSDoc/TSDoc strict checks
pnpm lint:spelling   # CSpell over comments + docs
pnpm typecheck       # tsc --noEmit (strict + exactOptionalPropertyTypes)
pnpm run audit:deps  # Dependency advisory audit (moderate+), expiring GHSA allowlist
pnpm docs            # Generate TypeDoc API docs under ./api-docs
pnpm clean           # rm -rf dist api-docs
pnpm verify          # Full local gate (lint, typecheck, tests, build, exports) — mirrors CI
```

Run `pnpm verify` before claiming a change is done. CI runs the same gate on
Linux + Windows + macOS (Node 22 and 24) plus `bun test src/` and the per-engine
browser matrix.

## Conventions that bite (full list in [ARCHITECTURE.md](ARCHITECTURE.md))

- **`exactOptionalPropertyTypes` is ON** — never pass `{ x: undefined }` for `x?: T`; use `...(v !== undefined ? { x: v } : {})`.
- **`verbatimModuleSyntax` is ON** — `import type` for types, value imports for runtime (incl. `instanceof`).
- **Internal imports use `.ts` extensions, never `.js`** — the Deno typecheck job fails immediately otherwise.
- **No top-level await** (CJS) — `streams/hash.ts` lazily inits the crypto backend; `IncrementalSha1.update()` is async.
- **`noUncheckedIndexedAccess` is ON** — index access is `T | undefined`; handle it.
- **`expect(promise).rejects`, never `expect(asyncFn).rejects`** — Bun's matcher needs an already-running promise. Wrap `for await` assertions in an invoked IIFE. The `bun test src/` CI job catches regressions.

## Testing

Tests use the in-memory `B2Simulator` (no network):

```ts
const sim = new B2Simulator()
const client = new B2Client({ applicationKeyId: 'test-key-id', applicationKey: 'test-key', transport: sim.transport() })
await client.authorize()
```

| Pattern | Runs in |
|---|---|
| `**/*.test.ts` | Node (`pnpm test`) **and** browser (`pnpm test:browser`) — must be isomorphic |
| `**/*.node.test.ts` | Node only — use when touching `node:fs`/`node:os`/`node:util`/OS keychain |

Browser: `pnpm exec playwright install chromium firefox webkit` once; scope with
`VITEST_BROWSER_INSTANCE=chromium|firefox|webkit`. Real-B2 integration tests are
gated on `B2_APPLICATION_KEY_ID` + `B2_APPLICATION_KEY` (Partner/Backup on
`B2_MASTER_KEY_ID` + `B2_MASTER_KEY`) and skip cleanly without them.

## CI

Every pull-request-triggered workflow (`ci`, `examples`, `security`,
`integration`, `quality-run-demo`) is guarded with
`if: ${{ github.event.pull_request.user.login != 'dependabot[bot]' }}` so
Dependabot PRs skip all CI (dependency bumps are consolidated manually). **When
you add a job to a PR-triggered workflow, add the same guard** (AND it into any
existing `if`). Docs-only PRs skip the heavy matrix via `.github/actions/detect-changes`.

## Formatting

Biome: 2-space indent, single quotes, trailing commas, 100-char width. Run
`pnpm lint:fix` before submitting. Prefer `as unknown as T` over `as any` in tests.

## User-facing docs policy

`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `examples/**/README.md`, and
anything shipped to npm or the repo landing page are **for users**, not marketing
or internal scorecards:

- **No competitor comparisons** ("X of N packages ship without Y", naming rival packages).
- **No internal scorecards** in user docs — coverage %, test counts, runtime matrices, lint-gate semantics belong in `CONTRIBUTING.md` / `CHANGELOG.md` / CI files / this file.
- **Describe what the SDK does, how to use it, and what to watch out for**, in that order.

## Git & commit policy

- **Do not** run `git add/commit/push/rebase` or `gh pr create` unless the user
  explicitly asks for that action in the current turn. Edit files freely; suggest
  commands otherwise.
- Commit messages: **single line, subject only**, under 72 chars, Conventional-Commits
  prefix (`feat:`/`fix:`/`docs:`/`test:`/`refactor:`/`chore:`/`ci:`/…).
- **Never add AI attribution** — no `Co-Authored-By: Claude/…` trailer, and don't
  name any AI tool in the subject or body.
