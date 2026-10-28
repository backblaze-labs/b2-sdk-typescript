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
- `Makefile` (new) - `ci` / `verify` targets wrapping `pnpm verify` (R7).

## Order of work
1. Install skills; copy `CODE_OF_CONDUCT.md` from the sibling b2-mcp repo (R1, R3).
2. Author `REVIEW.md`, the `intent/` chain, issue/PR templates, `Makefile`
   (R2, R4, R5, R7).
3. Point `AGENTS.md` at the play layer (R6).
4. Run `pnpm verify`; fix any spelling / docs-consistency fallout (R8).

## Risks
- `pnpm verify`'s `lint:spelling` and `verify:docs-consistency` may reject new
  root docs (concern: spelling dictionary, cited-number drift). Mitigation: run
  the full gate before opening the PR; add project-dictionary words as needed.
- Scope creep into the release pipeline. Mitigation: changelog tooling is a
  separate proposal intent (spec concern 1), not implemented here.

## Proof
- R1: `ls .claude/skills` shows the router + `sdlc-*`; the skills load in Claude
  Code.
- R2-R7: the files exist and render; `AGENTS.md` links resolve.
- R8: `pnpm verify` is green locally and in CI; `git diff --stat` shows no `src/`
  changes.
