# Review lessons from merged PRs

What reviewers kept finding on this repo, distilled into checks to run on every
new PR. Source: every review thread on every merged PR up to October 2026 (133
PRs, 728 threads). Almost all threads were opened by Copilot or CodeQL; the
author's replies show which findings were fixed and which were declined.

A handful of large PRs dominate the counts (sync hardening, sync filters, upload
retries, resumable uploads, SHA-1 compare, S3 presign), so the sync and upload
themes are over-represented. Counts are approximate; a thread can fit more than
one theme. [`REVIEW.md`](../../REVIEW.md) holds the short checklist; this file is
the detail behind it.

## Themes, most frequent first

### 1. Docs, JSDoc, changelog and PR body drift (~110 threads, ~30 PRs)

The single most common finding. Behavior changed and some prose did not.

- Re-read the JSDoc of every touched symbol, the README snippets, `AGENTS.md`,
  `CONTRIBUTING.md`, `RELEASE.md`, `llms.txt` and the changie fragment against the
  final code. Watch adjectives: "deterministic", "exact", "removed", "always",
  "covered by tests", "exclusive" vs "inclusive" cursors, "host" vs "origin".
- `@returns` must match the TS return type (an async generator is not a
  `Promise`; `await synchronize()` on a generator does nothing).
- After a review flips a behavior, re-check the PR body and the fragment: they
  drift in both directions. Decide the contract once and judge later findings
  against it.
- A renamed or deprecated symbol must disappear from contributor docs too.
- `{@link}` targets must be exported from a public entrypoint.

### 2. Cancellation, cleanup and leaked resources (~80 threads, ~10 PRs)

- The caller's `AbortSignal` (or the abort-scope signal, not `options.signal`)
  reaches every await: recursive walks, `reader.read()`, `finishLargeFile`, raw
  `postJson`, list calls. A stalled step must settle promptly with the caller's
  reason. Use `signal.throwIfAborted()`, not `throw signal.reason`.
- Cleanup requests (`cancelLargeFile` and friends) must not reuse an
  already-aborted signal, and must be bounded by a timeout.
- Every early exit (abort, throw, cancel before first `pull`) cancels response
  bodies, closes handles, calls `iterator.return()`, clears or `unref()`s timers,
  and attaches `.catch` to the losing side of a `Promise.race`.
- Cleanup errors are best-effort and never mask the root cause; surface the first
  real failure, not a sibling `AbortError`.
- Async generators drain in-flight work on abort and on scan errors instead of
  returning while transfers keep running.
- Shared in-flight promises (reauth) must not be killed by one waiter aborting.

### 3. Tests that would pass if the fix were reverted (~65 threads, ~25 PRs)

- The test title matches what the body does (it really aborts, really runs in
  parallel, really uses the named error code).
- Mocks reject unexpected URLs; clocks are frozen for signatures; signatures and
  shapes are asserted, not just "defined"; assert length before indexing.
- No sleeps to order events; use promise gates (`test-utils/deferred`).
- Restore globals and descriptors in `finally`; do not depend on env vars such
  as `RELEASE_CHANNEL`.
- Verifier scripts fail when there is nothing to verify (missing `dist/`).
- Test files typecheck under the same strict config: branded ID factories, no
  `as never`, no options a method does not declare.
- New branches and entry points get a negative case, on every sibling entry point
  (`uploadFile` and `uploadPart`, `bucket.ts` and `object.ts`).
- Do not lower coverage thresholds to make a PR pass.

### 4. Simulator fidelity (~60 threads, ~20 PRs)

- The simulator rejects what real B2 rejects: wrong JSON types (string `"false"`),
  `null` where a value is required, malformed numbers (`0x10`, `1e3`), empty
  arrays, malformed auth (403, not 401), deleted or forged keys and tokens.
- It reuses the SDK's wire helpers (`encodeFileName`, `buildFileInfoHeaders`),
  reads headers case-insensitively, sorts by code point (never `localeCompare`),
  and uses one clock consistently.
- `strictAuth` scope covers every input shape: fileId, largeFileId, copy source
  and destination, list prefixes, download paths, `create_bucket`, Partner calls.
- Error status and message match the SDK's code-to-status table and tell
  "missing" apart from "invalid".
- Encryption: malformed or partial SSE-C is rejected (never silently downgraded),
  copies keep SSE-C, digests are over decoded key bytes.

### 5. Local filesystem safety in sync (~60 threads, 4 PRs)

- A B2 key mapped to a local path rejects leading `/`, `..`, `.` and empty
  segments, drive prefixes and backslashes, and keys that collapse onto the same
  path (`docs/./a` vs `docs/a`). Check containment with `path.relative`.
- Act on file descriptors, not paths: exclusive create (`wx`), `O_NOFOLLOW`,
  `O_NONBLOCK` (FIFOs), `handle.chmod`; re-check identity right before publish.
- Write to a temp file, then rename; only remove temp files the SDK created; never
  `rm -r` something matched by a name pattern.
- Windows, macOS and cwd: UNC and drive-relative paths, rename after the stream
  `close` event, no `/proc/self/fd`, `EXDEV`, roots resolved once (not against a
  later `process.cwd()`), `/` and `C:\` roots without doubled separators.
- Sync semantics: the destination prefix applies to every mutation (copy, hide,
  delete), scanners sort with the shared code-point comparator, and decisions use
  current bytes rather than scan-time metadata.

### 6. Public API contract and back-compat (~60 threads, ~20 PRs)

- New fields on exported option types are optional; narrowed signatures get an
  overload or a deprecated alias. Order overloads so the `@deprecated` one is
  still selected (an `AbortSignal` is assignable to an all-optional options bag).
- Server-side enums stay open (`X | (string & {})`); literals only where the
  runtime enforces them.
- Exported types match runtime validation and real wire shapes (`null` variants,
  capability-filtered wrappers, no key material in public encryption types).
- New values reach the package root and subpath barrels (`export type *` drops
  values); exported mutable maps are copies, not the internal object.
- Breaking changes get a `BREAKING:` changie fragment, including type-only breaks.
- Per-call options win over client defaults (`{ ...defaults, ...options.retry }`).

### 7. Input validation and untrusted data (~55 threads, ~15 PRs)

- `null` vs `undefined` is meaningful: normalize B2 `T | null` before sending it
  back on the wire (`nextFileId: null` must not become `startFileId: null`); never
  collapse a documented `null` with `??`; check `Bucket | null` with `!== null`.
- Public helpers reject NaN, Infinity, negatives, fractions, invalid `Date`s,
  blank strings and unknown enum values before signing or scheduling anything.
- Dictionaries built from API responses, headers, `fileInfo` or query params use
  `Object.create(null)` (prototype pollution).
- Unknown or unreadable values are handled conservatively: an unreadable
  `{ isClientAuthorizedToRead: false }` value is never "empty" or "unlocked".
- Regexes: no backtracking hazards on user input (CodeQL flags these), and
  full-string validators do not rely on `$` alone (it matches before `\n`).
- Client-side and simulator limits come from one shared constant.

### 8. Cross-runtime portability (~35 threads, ~12 PRs)

- Nothing reachable from an isomorphic entrypoint has a static `node:*` import,
  including `import type` (it lands in `.d.ts`). Use structural types and lazy
  `await import`.
- `src/**/*.test.ts` also runs in Playwright: Node-only tests go in
  `*.node.test.ts`.
- Feature-detect `AbortSignal.any` / `timeout`; prefer structural checks to
  `instanceof ReadableStream` (cross-realm).
- WebCrypto: never pass a Buffer slab or shared view (copy the exact bytes);
  replacing `globalThis.crypto` in tests must keep `subtle`.
- Scripts in `pnpm verify` work on Windows (`pnpm.cmd`, no shell `rm -rf`, CRLF).

### 9. Hot paths and unbounded work (~40 threads, ~8 PRs)

- Per-file and per-object code: cheap filters before I/O, one traversal, no
  repeated normalization or double sorting, no `Array#shift` in loops, lazy
  decoding, no extra `Uint8Array` copies.
- Short-circuit before hashing, listing or downloading (size mismatch, digest
  already verified, byte budgets); do not call APIs whose result is unused.
- Caches and maps are scoped to one run and cleaned up; empty chunks are capped.

### 10. Retry, idempotency and error semantics (~35 threads, ~10 PRs)

- Classify endpoints by parsed `pathname`, never `url.includes('b2_...')`
  (download-by-name paths can contain `b2_upload_file`).
- A 2xx whose body fails to parse may have committed: no cancel, emit
  `finish-ambiguous`. Pre-dispatch failures stay retryable; error classes are
  preserved, not collapsed into `NetworkError`.
- `idempotent: false` is honored before the method check; reauth still retries
  once with `maxRetries: 0`; classifiers never throw.
- Typed errors pin `retryable` when their contract says so. Messages use SDK
  option names, include identifying IDs, and never absolute local paths.

### 11. Credentials and secrets (~30 threads, ~6 PRs)

- Any URL that receives a token or Basic credentials is absolute, HTTPS (plain
  HTTP only for loopback), with no userinfo, query or fragment. Cached-auth paths
  run the same realm checks as fresh authorization.
- Error messages and logs redact userinfo; nothing is logged by default
  (no `console.*` in `src/`).
- Examples never print application keys or SSE-C keys by default; redacting
  objects are passed through, not rebuilt (rebuilding drops `toJSON`).

### 12. CI workflows (~30 threads, ~10 PRs)

- Every `pull_request` job keeps the two-clause Dependabot guard.
- `github.event.pull_request.*` is read only when the event is `pull_request`.
- No PR-head checkout under `pull_request_target`; a PR cannot edit its own
  required gate.
- Destructive allow-flags are passed only on `workflow_dispatch`, never on
  schedule.
- Concurrency groups are keyed on the real ref, tag or PR number; build runs
  before verifiers that read `dist/`; the docs-only classifier handles nested
  paths.
- Version checks parse semver (`1.2.3+build-1` is not a prerelease).

### 13. Live integration tests (~10 threads, ~5 PRs)

- Gate on the minimum capabilities the test needs; a same-repo run with missing
  credentials fails rather than going green with everything skipped.
- Cleanup is idempotent ("key not found" counts as deleted), keeps the original
  error, and runs even when setup fails. Generated bucket names stay within B2
  limits; temporary keys are short-lived.

## Findings that were declined (do not re-litigate)

- **Move-aside overwrite on Windows rename.** Node `fs.rename` already replaces on
  Windows; a move-aside fallback reopens a crash window.
- **Best-effort delete fallback in sync.** Deletes fail closed on purpose; the
  fallback reintroduces the parent-symlink-swap risk.
- **Keep one `FileHandle` open across `FileSource.stream()` pulls.** Opening per
  pull is deliberate: an abandoned stream must not hold a descriptor or a Windows
  lock.
- **`new this()` in `FileSource.fromPath` for subclasses.** Removed on purpose so
  there is one validated constructor.
- **Generic `access_denied` for protected deletes in the simulator.** B2 returns
  mode-specific `file_lock_*_protected` codes.
- **Falling back to the bucket default on partial SSE-C headers.** Reject with 400
  instead.
- **Dev-dependency `engines.node` vs the package `engines`.** The package floor
  is for consumers; the dev floor is documented separately. It only matters when
  CI pins a Node below the dev floor.
- **CodeQL "superfluous trailing arguments" on `TransformStream`.** The analyzer's
  externs are wrong; dismiss rather than restructure.
- **Inline-snapshot escaping suggestions** when the snapshot passes.

## How to read Copilot on this repo

- It repeats one finding at every site ("also appears on line X") and sometimes
  after the fix landed. Fix the class once, reply once.
- It can oscillate across rounds (asking for a contract, then its opposite).
  Write the contract in the PR body and hold to it.
- About one thread in fifteen is a formatter or wording nit Biome or the
  docs-consistency checker already covers.

## Automation backlog

Checks that would have caught a recurring theme mechanically, roughly by payoff:

| Check | Catches |
|---|---|
| Grep `dist/**/*.d.ts` for `node:`; lint `node:*` imports in isomorphic `src/` and non-`.node` tests | Theme 8 |
| `no-restricted-syntax` for `localeCompare` (sync, simulator), `encodeURIComponent` and `Date.now()` (simulator), `.includes('b2_` on URLs, `console.*` in `src/` | Themes 4, 5, 10, 11 |
| Public API report diff (API Extractor or a `.d.ts` diff) in CI | Theme 6 |
| Workflow check that every `pull_request` job carries the Dependabot guard; actionlint + zizmor in CI | Theme 12 |
| Shared adversarial fixtures: hostile keys and paths, realm URLs, bad numeric inputs | Themes 5, 7, 11 |
| Table-driven simulator scope test: every endpoint against bucket- and prefix-scoped keys | Theme 4 |
| Transport matrix test: error class x phase x `idempotent` x `maxRetries` | Theme 10 |
| docs-consistency: flag deprecated symbols in contributor docs, unresolved `{@link}` | Theme 1 |
| Import-cycle check (`madge --circular`) | Module hygiene |
| Compare dev-dependency `engines.node` with CI `node-version` pins | Theme 12 |
| Mutation testing on changed files (expensive; run on demand) | Theme 3 |
