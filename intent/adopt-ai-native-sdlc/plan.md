# Plan: Adopt the AI-native SDLC playbook (from intent.md and spec.md)

## Files that change
- `.claude/skills/ai-native-sdlc/`, `.claude/skills/sdlc-*/` (new) - the plays and
  their starter assets (R1).
- `REVIEW.md` (new) - review process (R2).
- `CODE_OF_CONDUCT.md` (new) - Contributor Covenant 2.1 (R3).
- `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `task.yml`, `config.yml`;
  `.github/PULL_REQUEST_TEMPLATE.md` (new) (R4).
- `intent/TEMPLATE.md`, `intent/adopt-ai-native-sdlc/{intent,spec,plan}.md`,
  `intent/review-tiering/intent.md` (new)
  (R5).
- `AGENTS.md` (edit) - add the "AI-native SDLC" section and repo-map rows (R6).
- `Makefile` (new) - `ci` / `verify` / `changelog-check` / `changelog-new` targets
  wrapping the pnpm scripts (R7).
- Changelog tooling (R9-R11): none; superseded by #401 on `main`.

## Order of work
1. Install skills; copy `CODE_OF_CONDUCT.md` from the sibling b2-mcp repo (R1, R3).
2. Author `REVIEW.md`, the `intent/` chain, issue/PR templates, `Makefile`
   (R2, R4, R5, R7).
3. Point `AGENTS.md` at the play layer (R6).
4. Run `pnpm verify`; fix any spelling / docs-consistency fallout (R8).
5. Merge `main` after #401 and drop this PR's own changie tooling (R9-R11).
6. Add the review layers: `REVIEW.md` contract, `docs/review-process.md`,
   `.github/review-policy.json` + `scripts/review-risk.mjs` + `review-risk.yml`,
   `CODEOWNERS`, `ai-review.yml` + security instructions, PR template sections,
   `scripts/review-metrics.mjs` + `review-metrics.yml`, `.claude/settings.json`
   format hook, `.claude/agents/reviewer.md` (R12).

## Risks
- `pnpm verify`'s `lint:spelling` and `verify:docs-consistency` may reject new
  root docs (concern: spelling dictionary, cited-number drift). Mitigation: run
  the full gate before opening the PR; add project-dictionary words as needed.

## Proof
- R1: `ls .claude/skills` shows the router + `sdlc-*`; the skills load in Claude
  Code.
- R2-R7: the files exist and render; `AGENTS.md` links resolve.
- R8: `pnpm verify` is green locally and in CI; `git diff --stat` shows no `src/`
  changes.
- R9-R11: `git diff main --stat` shows no changelog or release script changes.
- R12: `pnpm run review:test` (tier classification, head-commit-only human
  approvals); a dry run of `review-risk.mjs` against this PR reports `high`, 0/2;
  `review-metrics.mjs` over 120 days reports real rounds; the format hook rewrites
  a probe file; actionlint + zizmor clean on the new workflows.
