# Architecture Decision Records

Dated design docs (ADRs) for decisions that shape public API, package layout, authorization, simulator behavior, compatibility, or security posture. This is part of the `docs/` system of record; the entry point is [`AGENTS.md`](../../AGENTS.md).

> Not an ADR, but living here as a companion: [`core-beliefs.md`](core-beliefs.md) — the standing agent-first operating principles for this repo.

## Catalog

| ADR | Title | Status | Date | Issue |
|---|---|---|---|---|
| [0001](0001-partner-backup-module-architecture.md) | Partner and Computer Backup module architecture | Accepted | 2026-08-08 | [#160](https://github.com/backblaze-labs/b2-sdk-typescript/issues/160) |
| [0002](0002-native-api-docs-drift-guardrails.md) | Native API docs drift guardrails | Accepted | 2026-08-25 | [#108](https://github.com/backblaze-labs/b2-sdk-typescript/issues/108) |

Status values: `Proposed` · `Accepted` · `Superseded by NNNN` · `Deprecated`. Keep this table current when adding or superseding an ADR.

## Numbering

Use the next zero-padded sequence number and a short kebab-case title:

```text
0002-short-decision-title.md
```

Do not renumber existing ADRs. If a later decision changes an earlier one, add a new ADR and mark the older record as superseded.

## Format

Use the same section order as `0001-partner-backup-module-architecture.md`:

- `Status`
- `Date`
- `Issue`
- `Context`
- `Decision`
- `Resolved questions`
- `Consequences`

When an ADR creates follow-on implementation work, link the issue that requested the decision and list the known follow-on issues so implementers can find the recorded context.
