# Review process

What matters when reviewing `@backblaze-labs/b2-sdk`, for human reviewers and for
the automated reviewer (which reads this file on every PR). The question is not
"did a human read every line?" but "what could go wrong, and which check catches
it?". The layers that answer that (local verification, AI and security review,
CI, risk-tiered approval, release channels, rollback) are described in
[`docs/review-process.md`](docs/review-process.md). The detailed catalog of past
findings is [`docs/references/review-lessons.md`](docs/references/review-lessons.md).

Authoring guidance lives in [`AGENTS.md`](AGENTS.md); release steps in
[`RELEASE.md`](RELEASE.md); contributor setup in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## What failure looks like here

- **Docs lie.** JSDoc, README, contributor docs, the changelog fragment or the PR
  body describe behavior the code no longer has.
- **Cancellation leaks.** A new await ignores the caller's `AbortSignal`, or an
  early exit leaves a response body, file handle, timer or iterator open, or a
  cleanup error hides the root cause.
- **Tests pass for the wrong reason.** The test would still pass with the fix
  reverted.
- **The simulator agrees with the SDK instead of with B2.** It accepts input real
  B2 rejects, or its scoping lets a restricted key through.
- **Sync escapes or destroys.** A B2 key becomes a local path outside the root, or
  a delete or overwrite hits the wrong file.
- **The public contract breaks silently.** A new required field, a narrowed
  signature, `null` collapsed into `undefined`, or a value export missing from a
  barrel.
- **Secrets travel.** A token goes to an unverified URL, or a key reaches a log,
  an error message or an example's output.

## The one gate

`pnpm verify` is the single local command that mirrors CI (lint, lint:docs,
lint:spelling, changelog:lint, typecheck, tests, build, exports, docs
consistency, release checks). A change is not "done" until it is green. CI
re-runs the same gate on Linux + Windows + macOS plus `bun test src/` and the
browser matrix.

## Recurring lessons (check these first)

- **Changelog.** Every user-visible change adds a changie fragment
  (`pnpm run changelog:new`) under `.changes/unreleased/`; never hand-edit the
  generated `CHANGELOG.md`. Breaking changes start the entry with `BREAKING:` and
  say what callers must change. The `changelog` check enforces this for non-test
  `src/` changes; reviewers catch user-visible changes outside `src/` (such as
  `package.json` exports or engines). See
  [CONTRIBUTING.md](CONTRIBUTING.md#changelog-entries).
- **Tests fail when the fix is reverted.** Never skip or delete a failing test,
  and never lower a coverage threshold, to go green.
- **Isomorphic tests.** `**/*.test.ts` run in Node and the browser, so they may
  not touch `node:*`. Node-only tests are `**/*.node.test.ts`.
- **Wire shape against ground truth.** Response-type and simulator changes cite
  the Backblaze B2 native-API docs. Where B2 capability-filters a field, model the
  `{ isClientAuthorizedToRead, value }` wrapper and fail closed.
- **Strictness conventions that bite** (full list in
  [`ARCHITECTURE.md`](ARCHITECTURE.md)): `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `.ts` internal import extensions,
  `noUncheckedIndexedAccess`, no top-level await.
- **Docs consistency.** `pnpm run verify:docs-consistency` reconciles cited
  numbers against ground truth. Change a number in source, update the prose in
  the same PR.
- **Commit + PR hygiene.** Conventional-Commits subject, single line, under 72
  chars. No AI attribution anywhere.

## AI reviewer contract

The automated reviewer (the `AI review` workflow, `/code-review`, or a
fresh-context subagent) follows these rules. Human reviewers should hold it to
them.

1. **Read the whole repo, not just the diff.** Check the change against the PR's
   stated intent (body, linked issue, `intent/<slug>/`), `AGENTS.md` and this
   file. Ask whether it solves the problem, fits the system, and breaks nothing
   else. On a bug fix, look for the root cause.
2. **Evidence or silence.** Every finding cites `path:line` and the concrete input
   or sequence that goes wrong. Never infer a bug from a name alone.
3. **Severity tags.** Prefix each inline finding with `Important` (a bug,
   regression, security or data-loss risk this PR introduces), `Nit` (style or
   wording), or `Pre-existing` (a real problem the PR did not introduce, so it is
   not attributed to the author).
4. **Cap nits at 3 per round.** No style-only findings that Biome, cspell or the
   docs-consistency check already enforce.
5. **Flag the class, once.** When the same bug appears at several sites, post one
   finding that names the class and lists the sites, so the author fixes every
   instance. Never post a finding again once it is on the PR, resolved or not.
6. **Skip** generated and vendored paths: `CHANGELOG.md`, `api-docs/`, `dist/`,
   `pnpm-lock.yaml`, `.changes/v*.md`, `src/**/__screenshots__/`.
7. **Rounds converge.** From the third round on, review only the diff since the
   last reviewed commit. After three rounds with Important findings, stop
   line-level review and ask the author to reconsider the approach.
8. **Summary first line is a count**, for example
   `2 Important, 1 Nit, 0 Pre-existing`, or `No issues found.` when nothing
   needs fixing. Then one line `Needs human review: yes|no` with a reason when
   yes (design direction, a pattern others will copy, or a risky area). Then the
   round number and the reviewed commit.
9. **Findings, never approvals.** An agent's approval never counts toward a
   required human approval.

## Responding to findings

Every finding gets an answer: fix it (and say how), or resolve the thread with a
one-line reason (false positive, intentional, out of scope with an issue link).
Findings in [declined patterns](docs/references/review-lessons.md#findings-that-were-declined-do-not-re-litigate)
can be resolved by pointing there. When the reviewer repeatedly flags the same
thing, fix the source instead: a lint rule, a test, or a line in `AGENTS.md` or
this file.

## Reviewer checklist

1. Does `pnpm verify` pass (CI green)?
2. Is there a `.changes/unreleased/` fragment, `BREAKING:`-tagged if it breaks
   callers (or a justified `skip-changelog` label)?
3. Do the tests fail when the change is reverted? Are new `**/*.test.ts`
   isomorphic?
4. Do response-shape / simulator changes match the cited B2 docs?
5. Do JSDoc, README, contributor docs, the fragment and the PR body still match
   the final behavior (`verify:docs-consistency` covers cited numbers)?
6. Does every new await honor the caller's `AbortSignal`, and does every early
   exit release bodies, handles, timers and iterators without masking the root
   error?
7. Are public types back-compatible (optional new fields, overloads or
   deprecated aliases) and do they match runtime validation and the wire shape
   (`null` vs `undefined`)?
8. Are untrusted inputs validated (numbers, paths, keys, realm URLs,
   `Object.create(null)` dictionaries) and nothing secret logged?
9. Are the PR template's Testing, Risk and How to revert sections filled in, and
   can you say what the checks would miss? If not, do a real review instead of a
   quick approval.
10. Is the change scoped, with a Conventional-Commits subject and no AI
    attribution?

## Who approves

The change, not the author, sets the risk tier. The `review-risk` check
classifies the changed paths with [`.github/review-policy.json`](.github/review-policy.json):
**low** (docs, tests, examples, fragments) needs no human approval once the
automated checks are green, **medium** (ordinary source and tooling) needs one,
**high** (CI, release tooling, `package.json`, auth, HTTP, raw wire, S3 signing,
Partner, Backup) needs two. Authors outside the trusted list need one more, and
the `needs-human-review` label forces at least one. Only human approvals of the
current head commit count. Details in
[`docs/review-process.md`](docs/review-process.md).

## How a change flows

Larger changes follow the AI-native SDLC artifact chain
(`intent/<slug>/intent.md` -> `spec.md` -> `plan.md`), which maps onto this
repo's harness layout: specs and plans live under
[`docs/exec-plans/`](docs/exec-plans/) and decisions become ADRs under
[`docs/design-docs/`](docs/design-docs/index.md). Start with the
`ai-native-sdlc` skill. Before opening a PR, run `pnpm verify`, then `/code-review`
and `/security-review` (or the `reviewer` subagent in `.claude/agents/`) on the
diff in a fresh context. Keep PRs small enough to review, debug and revert.
