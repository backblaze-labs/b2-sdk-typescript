# Intent: Scale human review by risk
Author: gpenacastellanos, Applied AI. Status: accepted, implemented in the SDLC adoption PR
(repo-admin settings pending).

## Decision
Adopt the layered model from Anthropic's "solving code review" write-up, documented in
`docs/review-process.md`: path-based risk tiers enforced by the `review-risk` check
(`.github/review-policy.json`; low 0, medium 1, high 2 human approvals, +1 for untrusted
authors, approvals count only on the head commit and never from bots), `CODEOWNERS` for
paths that always need a person, an AI review and a security review on every same-repo
PR (`ai-review.yml`), the REVIEW.md reviewer contract (severity tags, evidence, nit cap,
round cap, no reposts), a PR template with Testing / Risk / How to revert, and a weekly
`review-metrics` report with the revert share as the guardrail. Branch protection,
required checks, conversation resolution, stale-approval dismissal, the merge queue and
the API key remain repo-admin items (checklist in `docs/review-process.md`).

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
- Resolved: protected paths are the `high` rules in `.github/review-policy.json` and the
  `CODEOWNERS` entries; owners should add a second person per area.
- Merge queue: optional, admin decision.
- Resolved: metrics are human approvals, human comments and wait time per PR, automated
  review rounds, and the revert share as the guardrail (`scripts/review-metrics.mjs`).
