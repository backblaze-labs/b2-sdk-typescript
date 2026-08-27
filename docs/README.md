# docs — system of record

Repo-local, versioned knowledge base. If it isn't here (or in code), an agent
can't see it — so it doesn't exist. The entry point for agents is
[`../AGENTS.md`](../AGENTS.md); this tree is what it points into.

| Path | What |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | ~100-line operating map (start here). |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | Subpath exports, source layout, key design decisions. |
| [`design-docs/`](design-docs/) | ADRs — dated decision records + [status catalog](design-docs/index.md). |
| [`design-docs/core-beliefs.md`](design-docs/core-beliefs.md) | Agent-first operating principles for this repo. |
| [`QUALITY_SCORE.md`](QUALITY_SCORE.md) | Per-domain quality grades + tracked gaps. |
| [`exec-plans/`](exec-plans/) | First-class plans: [active](exec-plans/active/), [completed](exec-plans/completed/), [tech-debt-tracker](exec-plans/tech-debt-tracker.md). |
| [`references/`](references/) | External notes / reference material (e.g. the harness-engineering notes). |
| `../api-docs/` | Generated TypeDoc reference (`pnpm docs`; not versioned). |

Reference material for **users** (not this internal record) lives at the repo
root: [`../README.md`](../README.md), [`../CONTRIBUTING.md`](../CONTRIBUTING.md),
[`../CHANGELOG.md`](../CHANGELOG.md), [`../MIGRATION.md`](../MIGRATION.md),
[`../SECURITY.md`](../SECURITY.md).

## Staying consistent

Consistency is enforced mechanically, not by vigilance. `pnpm run
verify:docs-consistency` (`scripts/verify-docs-consistency.test.mjs`, part of
`pnpm verify` and CI's docs path) reconciles markdown claims against ground truth
— endpoint/export counts vs `package.json` + `src/`, coverage numbers vs the
vitest config, min Node vs `engines`, the ADR catalog vs the ADR files, every
relative link, and every `pnpm <script>` reference. When a class of drift keeps
recurring, add a check there rather than a paragraph here.
