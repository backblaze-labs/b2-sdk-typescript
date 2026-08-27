# Active exec-plans

In-flight plans that outlive a single session — multi-step work an agent should
resume rather than re-derive. One file per plan.

**Convention**

- Name files `NNNN-short-slug.md` (zero-padded, monotonic).
- Open with: goal, why now, and a checklist of steps with status.
- Update the checklist as you go — this file *is* the working memory.
- When the plan ships, move it to [`../completed/`](../completed/) and link the PR.

Small one-line deferrals don't need a file; add a row to
[`../tech-debt-tracker.md`](../tech-debt-tracker.md) instead.

_None active right now._
