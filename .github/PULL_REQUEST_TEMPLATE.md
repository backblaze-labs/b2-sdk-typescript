# Summary

<!-- 1-3 sentences: what changed and why. -->

## Changes

<!-- Bulleted list of notable changes. -->

-

## Linked issues

<!-- e.g. Closes #123 -->

-

## Verification

- [ ] `pnpm verify` passes locally (the full gate CI mirrors)
- [ ] Changelog fragment added with `pnpm run changelog:new`, `BREAKING:`-tagged if it breaks callers (or labeled `skip-changelog`)
- [ ] Tests fail when the change is reverted; new `**/*.test.ts` are isomorphic (Node + browser)
- [ ] Response-shape / simulator changes match the cited Backblaze B2 docs (or N/A)
- [ ] Cited doc numbers still true (`pnpm run verify:docs-consistency`)

<!--
Review process and the recurring lessons: REVIEW.md.
Authoring guidance: AGENTS.md. Larger changes: intent/<slug>/ (see REVIEW.md).
Conventional-Commits subject, single line, no AI attribution.
-->
