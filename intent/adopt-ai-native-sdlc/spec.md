# Spec: Adopt the AI-native SDLC playbook
From: intent.md (gpenacastellanos). Status: ready for review.
Skills applied: ai-native-sdlc, sdlc-intent, sdlc-spec, sdlc-harness-translate.

## Requirements
- R1. The `.claude/skills/` directory contains the playbook plays
  (`ai-native-sdlc` router plus `sdlc-*`), loadable in Claude Code from the repo
  root.
- R2. `REVIEW.md` exists at the repo root and documents the one gate
  (`pnpm verify`), the recurring review lessons, the change flow, and a reviewer
  checklist, linking to `AGENTS.md` / `CONTRIBUTING.md` / `RELEASE.md`.
- R3. `CODE_OF_CONDUCT.md` exists at the repo root (Contributor Covenant 2.1,
  enforcement contact `conduct@backblaze.com`).
- R4. `.github/ISSUE_TEMPLATE/` provides bug and feature forms plus a `config.yml`
  that routes security reports to private advisories and B2 service issues to
  Backblaze support; `.github/PULL_REQUEST_TEMPLATE.md` lists the verify gate and
  the recurring-lesson checklist.
- R5. `intent/` holds a `TEMPLATE.md` and this change's own `intent.md` /
  `spec.md` / `plan.md`, plus proposal intents for changelog fragments and review
  tiering.
- R6. `AGENTS.md` gains an "AI-native SDLC" section pointing to the skills, the
  artifact chain, and `REVIEW.md`, and maps the chain onto `docs/exec-plans/`. It
  stays the single source of truth; no guidance is duplicated into `CLAUDE.md`.
- R7. A `make ci` target mirrors `pnpm verify` for cross-repo parity.
- R8. The whole change passes `pnpm verify` (no new spelling, docs-consistency,
  or lint failures) and makes no `src/` behavior change.

## Design
All new files are docs, skills, templates, and a Makefile. No `src/`, no runtime
behavior, no release-pipeline change. The playbook's generic `intent/<slug>/`
chain is offered alongside, not instead of, the existing `docs/exec-plans/`
harness layout; `sdlc-harness-translate` is the bridge. The changelog-tooling and
review-tiering decisions are deferred to owner-reviewed proposal intents because
they touch the release pipeline and branch-protection policy respectively.

## How each constraint in the intent is met
| Constraint | Met by |
| :---- | :---- |
| Do not break the release pipeline | No `CHANGELOG.md` tooling change here; changie deferred to `intent/changelog-fragments/` (R5) |
| Stay green under `pnpm verify` | R8; docs-only + skills + templates, run the full gate before PR |
| Do not duplicate guidance | R6: one new section in `AGENTS.md`, `CLAUDE.md` still imports it |

## Open questions from the intent
- changie vs keep-and-extend: carried forward as `intent/changelog-fragments/`
  (concern 1).
- Review tiers and automated gates: carried forward as `intent/review-tiering/`
  (concern 2).

## Areas of concern
1. Changelog tooling migration touches `cut-changelog` / `extract-changelog` /
   `verify:metadata` / `release.yml`. Owner: release manager / code owners.
2. Review tiering needs branch-protection and required-check changes only a repo
   admin can make. Owner: code owners / repo admin.
