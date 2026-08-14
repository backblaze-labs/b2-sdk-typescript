# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for decisions that shape public API, package layout, authorization, simulator behavior, compatibility, or security posture.

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
