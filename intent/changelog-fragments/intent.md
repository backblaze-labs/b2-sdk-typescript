# Intent: Per-PR changelog fragments (evaluate changie)
Author: gpenacastellanos, Applied AI. Status: proposal (needs code-owner decision).

## Problem
`CHANGELOG.md [Unreleased]` is a single hand-edited section, so parallel PRs
routinely conflict on it during rebase. This recurred throughout the v0.4.0 cycle
(for example #238, #248, #252), where every rebase had to re-resolve the
`[Unreleased]` block by hand. Agents also sometimes forget the entry entirely.

## Proposed outcome
Per-PR changelog fragments so entries never conflict and the release assembles
them automatically. Two routes to decide between:

- Adopt changie (`.changie.yaml` + `.changes/unreleased/*.yaml`), as the sibling
  Blazer repo did, and rewire the release to assemble fragments.
- Keep the current Keep-a-Changelog pipeline and only add a lightweight per-PR
  fragment directory plus a CI check that each user-facing PR adds one, with a
  `skip-changelog` label escape hatch.

## Affected users and systems
Contributors; the release pipeline: `scripts/cut-changelog.mjs`,
`scripts/extract-changelog.mjs`, `scripts/verify-package-metadata.mjs`,
`.github/workflows/release.yml`, and `verify:docs-consistency`.

## Constraints
- Must preserve a working `release.yml` and the `extract-changelog` /
  `cut-changelog` behavior (or replace both atomically with tests).
- The `[Unreleased]`-to-version cut and the GitHub Release body must keep working.

## Open questions
- changie, or keep-and-extend? Who owns the release pipeline sign-off?
- Should the `changelog` / `fragment` check be a required check on `main`?
- Create a `skip-changelog` label?
