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
- R9. Changelog entries are changie fragments: `.changie.yaml` matches Blazer's
  (kinds, formats, newlines; changie 1.24.0), released history is migrated into
  `.changes/v*.md` with every released bullet byte-identical, pending
  `[Unreleased]` entries become `.changes/unreleased/*.yaml`, and the generated
  `CHANGELOG.md` keeps the `## [<version>] - <date>` headings.
- R10. The release pipeline keeps working: `pnpm version` batches + merges via
  `cut-changelog.mjs` (prereleases leave fragments alone; an empty release warns),
  `extract-changelog.mjs` still returns a version's section and renders pending
  fragments for prereleases, and `verify:metadata` still finds the version heading.
- R11. Enforcement: `pnpm run changelog:lint` (in `pnpm verify`) fails on
  unparseable fragments or a hand-edited `CHANGELOG.md`; a `changelog` PR workflow
  (Dependabot-guarded, `skip-changelog` label) fails a non-test `src/` change with
  no fragment.
- R12. Layered review per `docs/review-process.md`: `REVIEW.md` states what
  failure looks like and the AI reviewer contract; a `review-risk` check enforces
  path-based tiers from `.github/review-policy.json` (human approvals on the head
  commit only, bots never count) run from the base branch; `CODEOWNERS` covers
  always-human paths; `ai-review.yml` runs a Claude review and a security review on
  same-repo PRs and no-ops without `ANTHROPIC_API_KEY`; the PR template asks for
  Testing, Risk and How to revert; `review-metrics` reports weekly; a format hook
  and a `reviewer` subagent cover the pre-PR layer.

## Design
Docs, skills, templates, a Makefile, and the changie changelog tooling. No `src/`
or runtime behavior change. The playbook's generic `intent/<slug>/` chain is
offered alongside, not instead of, the existing `docs/exec-plans/` harness layout;
`sdlc-harness-translate` is the bridge. changie slots into the existing release
scripts (R9-R11) rather than replacing them. Review tiering is deferred to an
owner-reviewed proposal intent because it touches branch-protection policy.

## How each constraint in the intent is met
| Constraint | Met by |
| :---- | :---- |
| Do not break the release pipeline | changie slots into the existing `version` script and `extract-changelog`; rehearsed end to end (R10) |
| Stay green under `pnpm verify` | R8; docs-only + skills + templates, run the full gate before PR |
| Do not duplicate guidance | R6: one new section in `AGENTS.md`, `CLAUDE.md` still imports it |

## Open questions from the intent
- changie vs keep-and-extend: resolved, changie (`intent/changelog-fragments/`,
  concern 1).
- Review tiers and automated gates: carried forward as `intent/review-tiering/`
  (concern 2).

## Areas of concern
1. Changelog tooling migration touches `cut-changelog` / `extract-changelog` /
   `verify:metadata` / `release.yml`. Resolved: changie approved; the pipeline is
   kept and rehearsed (R9-R11). Remaining admin items: create the `skip-changelog`
   label and decide whether `changelog` is a required check.
2. Review tiering: implemented in-repo (R12). Branch protection, required checks,
   conversation resolution, stale-approval dismissal, the merge queue and the API
   key still need a repo admin (checklist in `docs/review-process.md`).
