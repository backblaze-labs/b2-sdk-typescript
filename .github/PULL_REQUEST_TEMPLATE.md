# Summary

<!-- 1-3 sentences: what changed and why. -->

## Changes

<!-- Bulleted list of notable changes. -->

-

## Linked issues

<!-- e.g. Closes #123 -->

-

## Testing

<!-- Commands you ran and what they showed (paste the relevant output), plus any
manual or live-B2 checks. "pnpm verify passes" alone is not enough for src/ changes. -->

## Risk

<!-- Tier from the review-risk check (low / medium / high) and why. What could go
wrong, and which check or reviewer would catch it? Anything the checks would miss? -->

## How to revert

<!-- e.g. "git revert <sha>; no data or API migration", or the dist-tag / flag to
roll back. Call out anything that cannot be reverted cleanly. -->

## Verification

- [ ] `pnpm verify` passes locally (the full gate CI mirrors)
- [ ] Changelog fragment added with `pnpm run changelog:new`, `BREAKING:`-tagged if it breaks callers (or labeled `skip-changelog`)
- [ ] Tests fail when the change is reverted; new `**/*.test.ts` are isomorphic (Node + browser)
- [ ] Response-shape / simulator changes match the cited Backblaze B2 docs (or N/A)
- [ ] JSDoc, README and contributor docs match the final behavior
- [ ] Every review finding is fixed or resolved with a reason

<!--
Review process and the recurring lessons: REVIEW.md and docs/review-process.md.
Authoring guidance: AGENTS.md. Larger changes: intent/<slug>/ (see REVIEW.md).
Conventional-Commits subject, single line, no AI attribution.
-->
