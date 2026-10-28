# Intent: Per-PR changelog fragments (evaluate changie)
Author: gpenacastellanos, Applied AI. Status: accepted (changie), implemented in the SDLC adoption PR.

## Decision
Adopt changie, pinned to the same version as Backblaze/blazer (1.24.0) with the same
`.changie.yaml` kinds, formats and layout, so every repo shares one changelog workflow.
Alternatives considered: changesets (rejected: replaces the Keep a Changelog format
and overlaps the custom `release.yml` publish), and extending `cut-changelog` with a
homegrown fragment format (rejected: more custom code, no cross-repo reuse). changie
comes from its official npm package as an exact-pinned devDependency (no install
scripts; bundled binaries), and the existing pipeline is kept rather than replaced:
`cut-changelog.mjs` now runs `changie batch` + `changie merge` from the `version`
lifecycle script, `extract-changelog.mjs` still reads the generated `CHANGELOG.md`
(prereleases render the pending fragments), and a `changelog` PR check mirrors
Blazer's.

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
- Resolved: changie (see Decision).
- Should the `changelog` check be a required check on `main`? (repo admin)
- Create the `skip-changelog` label. (repo admin)
