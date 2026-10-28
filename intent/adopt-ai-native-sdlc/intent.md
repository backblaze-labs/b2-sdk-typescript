# Intent: Adopt the AI-native SDLC playbook
Author: gpenacastellanos, Applied AI. Status: accepted.

## Problem
Most `@backblaze-labs/b2-sdk` PRs are now written with coding agents, and the
process around them has not fully caught up. The repo already has strong
foundations (AGENTS.md as the single source of truth, ARCHITECTURE.md, a docs/
system of record with ADRs and exec-plans, and `pnpm verify` as a one-command CI
mirror), but it is missing the explicit play layer that keeps agent-written
changes reviewable at speed:

- No written review process; the same review comments recur (changelog entry,
  tests that fail when reverted, wire shape vs the B2 docs, docs-consistency).
- The operational plays (capture intent, spec, plan, feedback loop, PR review,
  hooks, evals, close the loop) are not installed as skills, so each session
  reinvents them.
- `CHANGELOG.md [Unreleased]` is hand-edited, so parallel PRs conflict on rebase
  (seen repeatedly during the v0.4.0 cycle).
- No `CODE_OF_CONDUCT.md`, issue forms, or PR template.

## Proposed outcome
Adopt the AI-native SDLC playbook, adapted to this repo's existing
harness-engineering layout rather than layered on top of a parallel one:

- Install the `.claude/skills/sdlc-*` plays and point `AGENTS.md` at them.
- A written `REVIEW.md` that captures the recurring lessons and the one gate.
- A `CODE_OF_CONDUCT.md`, GitHub issue forms, and a PR template.
- The `intent/<slug>/` artifact chain available, mapped to `docs/exec-plans/` via
  the `sdlc-harness-translate` skill (this change dogfoods it).
- Proposals, for the code owners to decide, on per-PR changelog fragments and on
  scaling human review by risk.

## Affected users and systems
Contributors and reviewers of `backblaze-labs/b2-sdk-typescript`; coding agents
(Claude Code and others via `AGENTS.md`); CI.

## Constraints
- Must not break the existing release pipeline (`cut-changelog` /
  `extract-changelog` / `verify:metadata` / `release.yml` all parse
  `CHANGELOG.md`), so the changelog-tooling change is a separate, owner-approved
  decision, not part of this adoption.
- Must stay green under `pnpm verify` (lint, spelling, docs-consistency).
- Do not duplicate guidance: `AGENTS.md` stays the single source of truth;
  `CLAUDE.md` / `GEMINI.md` keep pointing at it.

## Open questions
- Adopt changie, or keep the current Keep-a-Changelog + cut/extract pipeline and
  only add per-PR fragments? Carried to `intent/changelog-fragments/`.
- Which review tiers and automated gates do the code owners want? Carried to
  `intent/review-tiering/`.
