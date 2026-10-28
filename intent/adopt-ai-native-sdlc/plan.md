# Plan: Adopt the AI-native SDLC playbook (from intent.md and spec.md)

## Files that change
- `.claude/skills/ai-native-sdlc/`, `.claude/skills/sdlc-*/` (new) - the plays and
  their starter assets (R1).
- `REVIEW.md` (new) - review process (R2).
- `CODE_OF_CONDUCT.md` (new) - Contributor Covenant 2.1 (R3).
- `.github/ISSUE_TEMPLATE/bug_report.md`, `feature_request.md`, `config.yml`;
  `.github/PULL_REQUEST_TEMPLATE.md` (new) (R4).
- `intent/TEMPLATE.md`, `intent/adopt-ai-native-sdlc/{intent,spec,plan}.md`,
  `intent/changelog-fragments/intent.md`, `intent/review-tiering/intent.md` (new)
  (R5).
- `AGENTS.md` (edit) - add the "AI-native SDLC" section and repo-map rows (R6).
- `Makefile` (new) - `ci` / `verify` / `changelog-check` / `changelog-new` targets
  wrapping the pnpm scripts (R7, R11).
- `.changie.yaml`, `.changes/` (new) - config, header, migrated `v*.md` history,
  pending fragments (R9).
- `scripts/changie.mjs`, `scripts/check-changelog.mjs` + test (new);
  `scripts/cut-changelog.mjs`, `scripts/extract-changelog.mjs` (edit);
  `scripts/verify-docs-consistency.test.mjs` (edit: skip `.changes/` inputs);
  `package.json` (changie devDependency + `changelog:*` scripts) (R10, R11).
- `.github/workflows/changelog.yml` (new) (R11).
- `CHANGELOG.md` (regenerated), `CONTRIBUTING.md`, `RELEASE.md`, `REVIEW.md`,
  PR template (edit) (R9-R11).

## Order of work
1. Install skills; copy `CODE_OF_CONDUCT.md` from the sibling b2-mcp repo (R1, R3).
2. Author `REVIEW.md`, the `intent/` chain, issue/PR templates, `Makefile`
   (R2, R4, R5, R7).
3. Point `AGENTS.md` at the play layer (R6).
4. Run `pnpm verify`; fix any spelling / docs-consistency fallout (R8).
5. Add changie: config mirroring Blazer, migrate history + pending entries,
   rewire `cut-changelog` / `extract-changelog`, add the check + workflow, update
   the release and contributor docs (R9-R11).
6. Rehearse a release in a scratch copy and re-run `pnpm verify` (R10).

## Risks
- `pnpm verify`'s `lint:spelling` and `verify:docs-consistency` may reject new
  root docs (concern: spelling dictionary, cited-number drift). Mitigation: run
  the full gate before opening the PR; add project-dictionary words as needed.
- Breaking the release pipeline or losing changelog history. Mitigation: keep
  `cut-changelog` / `extract-changelog` as the entry points, diff the regenerated
  `CHANGELOG.md` against the original, and rehearse a release in a scratch copy.

## Proof
- R1: `ls .claude/skills` shows the router + `sdlc-*`; the skills load in Claude
  Code.
- R2-R7: the files exist and render; `AGENTS.md` links resolve.
- R8: `pnpm verify` is green locally and in CI; `git diff --stat` shows no `src/`
  changes.
- R9: `changie merge` regenerates `CHANGELOG.md` with every released bullet
  unchanged; `changie batch auto --dry-run` reproduces the old `[Unreleased]`
  bullets verbatim.
- R10: scratch-copy rehearsal of `pnpm version` (batch, compare link, fragment
  cleanup, extraction, double-run guard, empty-release warning).
- R11: `scripts/check-changelog.test.mjs`; negative runs (hand-edited
  `CHANGELOG.md`, unknown kind) fail; actionlint + zizmor clean on the workflow.
