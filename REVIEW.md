# Review process

One written process so reviews do not run at human speed while code is written
by agents. Most `@backblaze-labs/b2-sdk` changes are now drafted with coding
agents; this file is the checklist those agents and their reviewers read before
code is written, so the same comments stop recurring on every PR.

Authoring guidance lives in [`AGENTS.md`](AGENTS.md); release steps in
[`RELEASE.md`](RELEASE.md); contributor setup in
[`CONTRIBUTING.md`](CONTRIBUTING.md). This file is the reviewer-facing companion.

## The one gate

`pnpm verify` is the single local command that mirrors CI (lint, lint:docs,
lint:spelling, typecheck, tests, coverage gates, build, exports, docs
consistency, release checks). A change is not "done" until it is green. Reviewers
should assume a PR ran it; CI re-runs the same gate on Linux + Windows + macOS
(Node 22.22.2 and 24) plus `bun test src/` and the browser matrix.

## Recurring lessons (check these first)

These are the review comments that kept repeating. Check them before the deeper
logic review.

- **Changelog.** Every user-visible change adds a changie fragment
  (`pnpm run changelog:new`) under `.changes/unreleased/`; never hand-edit the
  generated `CHANGELOG.md`. Breaking changes start the entry with `BREAKING:` and
  say what callers must change. One entry per change, one line each. The
  `changelog` check enforces this for non-test `src/` changes; reviewers catch
  user-visible changes outside `src/` (such as `package.json` exports or engines).
  See [CONTRIBUTING.md](CONTRIBUTING.md#changelog-entries).
- **Tests fail when the fix is reverted.** A fix without a test that would catch
  its regression is not reviewable. Never skip or delete a failing test to go
  green.
- **Isomorphic tests.** `**/*.test.ts` run in Node and the browser, so they may
  not touch `node:*`. Node-only tests are `**/*.node.test.ts`. The `bun test
  src/` job catches `expect(asyncFn).rejects` and module-mock regressions.
- **Wire shape against ground truth.** Response-type and simulator changes cite
  the Backblaze B2 native-API docs, not assumptions. Where B2 capability-filters
  a field, model the `{ isClientAuthorizedToRead, value }` wrapper and fail
  closed. New wire behavior is mirrored in `B2Simulator` so a test exercises it.
- **Strictness conventions that bite** (full list in
  [`ARCHITECTURE.md`](ARCHITECTURE.md)): `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` (`import type`), `.ts` internal import extensions,
  `noUncheckedIndexedAccess`, no top-level await.
- **Docs consistency.** `pnpm run verify:docs-consistency` reconciles cited
  numbers (coverage, export counts, min Node, ADR catalog, links) against ground
  truth. Change a number in source, update the prose in the same PR.
- **Commit + PR hygiene.** Conventional-Commits subject, single line, under 72
  chars. No AI attribution anywhere (no `Co-Authored-By`, no tool name in the
  subject or body).

## How a change flows

Larger changes follow the AI-native SDLC artifact chain
(`intent/<slug>/intent.md` -> `spec.md` -> `plan.md`), which maps onto this
repo's harness layout: specs and plans live under
[`docs/exec-plans/`](docs/exec-plans/) and decisions become ADRs under
[`docs/design-docs/`](docs/design-docs/index.md). The `.claude/skills/sdlc-*`
plays drive each stage; start with `ai-native-sdlc` and use
`sdlc-harness-translate` to move between the `intent/` and `docs/exec-plans/`
layouts. Small, low-blast-radius changes can skip straight to a planned PR.

## Reviewer checklist

1. Does `pnpm verify` pass (CI green)?
2. Is there a `.changes/unreleased/` fragment, `BREAKING:`-tagged if it breaks
   callers (or a justified `skip-changelog` label)?
3. Do the tests fail when the change is reverted? Are new `**/*.test.ts`
   isomorphic?
4. Do response-shape / simulator changes match the cited B2 docs?
5. Are cited doc numbers still true (`verify:docs-consistency`)?
6. Is the change scoped (no unrelated edits), with a Conventional-Commits
   subject and no AI attribution?

## Scaling review by risk

How far human review scales by risk (tiers, re-approval on new commits, required
conversation resolution, automated AI and security review, merge queue, reviewer
evals, metrics) is a proposal for the code owners to decide, captured in
[`intent/review-tiering/intent.md`](intent/review-tiering/intent.md). This file
documents the baseline every change gets today.
