# Core beliefs

Agent-first operating principles for `@backblaze-labs/b2-sdk`. These are the
opinionated defaults that keep the codebase legible and consistent across runs.
When a rule here conflicts with a local pattern, this file wins — and if the code
disagrees with a documented invariant, one of them is a bug.

## Correctness at the boundary

- **Never build on a guessed wire shape.** Parse and type every B2 response at the
  raw-client boundary; validate inputs before they reach the network. Where the
  docs conflict with reality, confirm against **live B2** and record it in an ADR
  (see [`0002-native-api-docs-drift-guardrails.md`](0002-native-api-docs-drift-guardrails.md)),
  not by editing types on a hunch.
- **Fail closed.** Redact secrets by default (`EncryptionKey`, partner tokens),
  reject non-idempotent replays, guard SSRF on the default transport. A missing
  capability or unknown shape is an error, not a silent pass.

## Isomorphism is non-negotiable

- Everything under `src/` must run in Node, browsers, Bun, Deno, and edge runtimes.
  `*.test.ts` runs in all of them; only `*.node.test.ts` may touch `node:*`.
- No top-level await; lazy-init platform backends. Web Streams, not Node streams.
  Internal imports use `.ts` extensions (see [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md)).

## Boring, internalizable tech

- **Zero runtime dependencies in core.** Prefer a small, fully-tested in-repo
  helper the agent can read over an opaque upstream package. `src/util/` and
  `src/internal/` exist for exactly this.

## Enforce invariants, not implementations

- Strictness is mechanical: `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `noUncheckedIndexedAccess`, `--error-on-warnings` lint, the v4-route policy, the
  coverage gate. Lint/typecheck error messages are the remediation — read them.
- One command is the gate: **`pnpm verify`** mirrors CI. Green locally = green in CI.

## Tests are the safety net

- Tests use the in-memory `B2Simulator`, never the network. Credentialed live
  suites confirm the wire contract and **skip cleanly** without credentials — a
  limited-but-valid key produces honest skips, never a red build.

## Docs are the system of record

- Write concise docs; say it once and link. [`../../AGENTS.md`](../../AGENTS.md) is
  a map, not a manual. When a rule keeps getting broken, promote it into code (a
  lint, a type, a test) rather than adding more prose.
