# ADR 0002: Native API docs drift guardrails

Status: Accepted for guardrails; live/API-schema validation pending

Date: 2026-08-24

Issue: [#108](https://github.com/backblaze-labs/b2-sdk-typescript/issues/108)

## Context

The SDK drift audit found generated Backblaze native API documentation shapes that
conflict with the SDK's current wire model. This ADR records guardrails for those
candidate docs-generation issues; it does **not** record completed live API or
authoritative schema validation.

- `b2_copy_file` is rendered as returning an array, while the SDK expects one
  copied file-version object.
- `lifecycleRules` is rendered as `object` in some field tables, while examples
  and the SDK model use a JSON array.
- `replicationConfiguration` is rendered inconsistently: bucket response examples
  include the authorization wrapper, while some field tables describe the direct
  replication object. The SDK currently uses the direct object for create and
  update requests, and `{ isClientAuthorizedToRead, value }` for bucket
  responses.

The native API docs repository named in the issue,
`backblaze-labs/b2-native-api-docs`, was rechecked with
`gh repo view backblaze-labs/b2-native-api-docs` on 2026-08-24 and still did not
resolve for the authenticated user. The findings therefore remain tracked here
until they can be moved or reported upstream.

The local PR validation run did not set `B2_APPLICATION_KEY_ID` or
`B2_APPLICATION_KEY`, so the live-contract tests were skipped. Issue #108 should
remain open until a credentialed live run or authoritative Backblaze schema
result is recorded for each tracked shape.

## Decision

Do not change SDK types from generated native API docs alone. Keep the SDK's
current contracts unless they are contradicted by live API validation or a more
authoritative Backblaze source schema.

Add pending-validation guardrails for the three tracked shapes in the gated live
integration suite:

- `tests/integration/live-contracts.test.ts` asserts that live `b2_copy_file`
  returns one plain file-version object, not an array.
- Separate tests assert that live bucket update and list responses expose
  `lifecycleRules` as arrays.
- Separate tests assert that live bucket update and list responses expose
  `replicationConfiguration` as an authorization wrapper. Request shapes remain
  the direct `ReplicationConfiguration` object documented by the Backblaze Cloud
  Replication native API guide.

Validation source and result for all three shapes: pending. Run the following
with live credentials before closing issue #108:

```sh
B2_APPLICATION_KEY_ID=... B2_APPLICATION_KEY=... \
  pnpm exec vitest run tests/integration/live-contracts.test.ts --config vitest.integration.ts
```

## Resolved questions

1. Generated docs are not sufficient evidence for a breaking SDK type change.
2. Live contract tests are the pending-validation and regression guard for
   docs-generation drift when B2 credentials are available; they skip normally
   without credentials.
3. The SDK should preserve the intentional request/response distinction for
   `replicationConfiguration`: direct object on create/update requests, wrapped
   object on bucket responses.

## Consequences

Future drift-audit work should update SDK types only after a live API run or an
authoritative Backblaze schema confirms the generated documentation. If the
native API docs repository becomes accessible, move or report the three findings
there and link back to issue #108.

The live guardrails do not add a v1.0 surface change. They document and protect
the existing pre-1.0 contract so future maintainers do not chase generated-docs
artifacts without validation.
