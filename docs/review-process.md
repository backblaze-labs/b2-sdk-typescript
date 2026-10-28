# Review process: layers, tiers and metrics

How `@backblaze-labs/b2-sdk` keeps review fast without letting bugs through, adapted
from Anthropic's write-up on solving code review for agent-written code
(<https://claude.dev/blog/solving-code-review-at-anthropic/>). The goal is the
least human review time that does not raise reverts or incidents. Instead of
asking "did a human read the code?", ask "what could go wrong, and which check,
automated or human, should catch it?".

[`REVIEW.md`](../REVIEW.md) is the short, reviewer-facing contract. This file is
the system around it. Items marked **admin** need a repo admin and are tracked in
the [setup checklist](#repo-admin-setup).

## The layers

| # | Layer | In this repo |
|---|---|---|
| 1 | Verification before the PR | `pnpm verify` (the full CI mirror); the Biome format hook in [`.claude/settings.json`](../.claude/settings.json); `/code-review`, `/security-review` or the [`reviewer`](../.claude/agents/reviewer.md) subagent on the diff in a fresh context; [`AGENTS.md`](../AGENTS.md) kept short, [`REVIEW.md`](../REVIEW.md) owned by the code owners. |
| 2 | AI review on every PR | The `claude-review` job in [`ai-review.yml`](../.github/workflows/ai-review.yml), following the REVIEW.md contract (severity tags, evidence, nit cap, rounds, no reposts). Copilot review also runs. Alternatively, an admin enables managed Code Review for Claude Code with Quick, Standard or Deep depth (**admin**). |
| 3 | Security review on every PR | The `security-review` job in `ai-review.yml`, with SDK-specific guidance in [`security-review-instructions.txt`](../.github/security-review-instructions.txt); CodeQL, zizmor and the dependency audit in `security.yml`. |
| 4 | Blocking automated checks | `ci.yml` (lint, typecheck, tests on Linux, macOS and Windows, Bun, browsers, build, exports), `changelog`, `security`, `review-risk`. Blocking requires them as required checks (**admin**). The PR template asks for Testing, Risk and How to revert. |
| 5 | Risk-tiered human approval | The `review-risk` check with [`.github/review-policy.json`](../.github/review-policy.json) (see [Risk tiers](#risk-tiers)), [`CODEOWNERS`](../.github/CODEOWNERS) for paths that always need a person. |
| 6 | Merge queue and staged release | Releases go to the `next` dist-tag before `latest` ([RELEASE.md](../RELEASE.md)). A merge queue re-runs checks against current `main` (**admin**). |
| 7 | Detection and rollback | Small PRs, `npm dist-tag` rollback and `git revert` ([RELEASE.md](../RELEASE.md)); live-B2 integration runs; the weekly `review-metrics` report. Every revert or incident asks which layer should have caught it, then adds a lesson and an eval. |

## Risk tiers

The change sets the tier, not the author. The `review-risk` check
([`scripts/review-risk.mjs`](../scripts/review-risk.mjs)) runs from the base
branch, classifies every changed path with the first matching rule in
[`.github/review-policy.json`](../.github/review-policy.json), and takes the PR's
riskiest file:

| Tier | Paths (summary) | Human approvals |
|---|---|---|
| low | docs, `intent/`, examples, changelog fragments, tests | 0 once automated review and checks are green |
| medium | other `src/`, scripts, configs, agent configuration | 1 |
| high | CI workflows and actions, review policy, release tooling, `package.json`, `src/auth`, `src/http`, `src/raw`, `src/s3`, `src/partner`, `src/backup` | 2 |

- Authors outside `trustedAuthors` need one more approval.
- The `needs-human-review` label (applied when the AI reviewer answers
  `Needs human review: yes`, or by anyone) forces at least one.
- Only human approvals count: bot, Copilot and agent approvals never do, and
  neither does the author's own. The person who prompted an agent-written PR is
  its author for this purpose and owns the outcome.
- An approval covers one commit. A new push needs a fresh approval; a human
  "changes requested" blocks until it is dismissed or replaced.
- Start strict and loosen with evidence from the metrics, never the other way.

## Where humans stay in the loop

Direction, scope and taste (whether to build it at all); risky code (credentials,
wire protocol, release and CI); architecture others will copy; and reading the
evidence (test output, commands run, reviewer findings). If you cannot say what
the checks would miss, do a real review instead of approving. Raise a different
direction early in the thread, not as a blocking comment on a finished PR. Whoever
lands a change owns it.

## Metrics

[`scripts/review-metrics.mjs`](../scripts/review-metrics.mjs) runs weekly
(`review-metrics.yml`) and on demand with `pnpm run review:metrics`. It reports,
for merged PRs:

- human approvals per PR and human comments per PR (median, p95);
- hours waiting on the first human review;
- automated review rounds per PR and the share needing five or more;
- the revert share, the guardrail: if it rises, human time was moved, not saved.

Baseline when this was adopted (120 days to October 2026, 108 merged PRs): a
median of 4 automated review rounds per PR, 39% of PRs needing 5 or more, and
almost no human approvals. The last 15 merged PRs had no review at all.

## Improving the reviewer

- Every revert or incident becomes a lesson in
  [`review-lessons.md`](references/review-lessons.md) and an eval case (the
  `sdlc-evals` skill): the PR that caused it, its fix, and the finding the
  reviewer should have made, confirmed by someone who knows that code.
- When the reviewer's prompt, `REVIEW.md` or the model changes, rescore it on
  those cases and on known-clean PRs; keep the change only if real findings go up
  without more noise.
- Classify reviewer comments by the author's response (fixed, wrong,
  intentional, did not matter). Repeated "wrong" or "did not matter" findings move
  into REVIEW.md's skip rules or the declined list.
- Catch real bugs first, then cut rounds. Noise costs more when the author is an
  agent, because each nit triggers another commit and another round.

## Repo admin setup

These need repo or organization admin rights:

- [ ] Add the `ANTHROPIC_API_KEY` repository secret (enables `ai-review.yml`), or
      enable managed Code Review for Claude Code on this repo and pick its depth
      (Deep for `src/auth`, `src/http`, `src/raw`).
- [ ] Ruleset on `main`: require a pull request; require status checks (`ci`
      jobs, `changelog`, `review-risk`, `security`); require conversation
      resolution (every finding answered); dismiss stale approvals on new
      commits; require code-owner review; block force pushes.
- [ ] Require approval for workflow runs from outside contributors (PR content is
      untrusted input to the AI reviewers).
- [ ] Create the `skip-changelog` and `needs-human-review` labels.
- [ ] Optionally enable the merge queue, and re-enable the Copilot review ruleset
      or rely on `ai-review.yml` alone.
- [ ] Keep `trustedAuthors` in the policy and owners in `CODEOWNERS` current.

Not adopted yet: an LLM classifier for tiers (paths are used instead), nightly
review agents over existing code, circuit breakers that tighten approvals when the
revert rate rises, and automatic fix rounds.
