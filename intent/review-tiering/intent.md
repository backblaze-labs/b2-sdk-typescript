# Intent: Scale human review by risk
Author: gpenacastellanos, Applied AI. Status: proposal (needs code-owner decision).

## Problem
Most PRs are agent-written and the review queue cannot scale by adding more human
passes to every change. Low-risk, well-tested changes and high-blast-radius ones
(release tooling, auth, the SSRF guard, the raw wire layer, Partner/Backup) get
the same single review today.

## Proposed outcome
A risk-tiered review policy for the code owners to accept, reshape, or reject:

- Tiers by blast radius (docs/tests, ordinary `src/`, protected paths such as
  `src/http/`, `src/raw/`, `src/auth/`, release tooling), each with its own
  required reviewers.
- Re-approval dismissed on new commits for higher tiers.
- Required conversation resolution before merge.
- Automated AI review and the existing security workflow as a first pass, with a
  human owner for the final call (never auto-approve).
- Optionally a merge queue, reviewer evals (see `.claude/skills/sdlc-evals`), and
  the leading/lagging metrics from `.claude/skills/sdlc-close-the-loop`.

## Affected users and systems
Code owners, reviewers, contributors; `.github/CODEOWNERS`, branch protection /
rulesets on `main`, required status checks.

## Constraints
- Most of this needs a repo admin: branch-protection rules, required checks,
  merge-queue enablement, CODEOWNERS paths.
- Must not make `main` unmergeable via a required check that is skipped on
  docs-only or Dependabot PRs.

## Open questions
- Which paths are "protected" and who owns each?
- Is a merge queue wanted now or later?
- Which metrics define whether the policy is working (leading and lagging)?
