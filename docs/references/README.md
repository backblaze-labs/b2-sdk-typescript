# References

External notes and reference material vendored into the repo so agents can read
the *why* behind our conventions without leaving the codebase.

| File | What |
|---|---|
| [`review-lessons.md`](review-lessons.md) | Recurring review findings mined from every merged PR, grouped into themes, with declined patterns and an automation backlog. Detail behind [`../../REVIEW.md`](../../REVIEW.md). |
| [`code-review-at-anthropic.md`](code-review-at-anthropic.md) | Notes on how the Claude Code team reviews agent-written code: review layers, risk tiers, reviewer tuning. Source for [`../review-process.md`](../review-process.md) and the review skills in `.claude/skills/`. |
| [`working-agreements.md`](working-agreements.md) | Template for the team habits that make light, fast review safe. |
| [`harness-engineering.md`](harness-engineering.md) | Working notes on harness engineering — the philosophy this repo's [`../../AGENTS.md`](../../AGENTS.md), [`../README.md`](../README.md), and `docs/` layout follow. Summary of an external article, in the author's own words with short quotes. |

These are context, not law. When a reference disagrees with a repo invariant, the
repo wins — open an ADR under [`../design-docs/`](../design-docs/) if the disagreement
is real.
