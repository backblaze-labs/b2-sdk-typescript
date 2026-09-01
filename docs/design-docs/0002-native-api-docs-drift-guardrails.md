# ADR 0002: Native API docs drift guardrails

Status: Accepted

Date: 2026-08-25

Issue: [#108](https://github.com/backblaze-labs/b2-sdk-typescript/issues/108)

## Context

The SDK drift audit found generated Backblaze native API documentation shapes that
conflict with the SDK's current wire model. This ADR records guardrails for those
candidate docs-generation issues and the live API evidence for each tracked
shape.

- `b2_copy_file` is rendered as returning an array, while the SDK expects one
  copied file-version object.
- `lifecycleRules` is rendered as `object` in some field tables, while examples
  and the SDK model use a JSON array.
- `replicationConfiguration` is rendered inconsistently: bucket response examples
  include the authorization wrapper, while some field tables describe the direct
  replication object. The SDK currently uses the direct object for create and
  update requests, and `{ isClientAuthorizedToRead, value }` for bucket
  responses.

Native docs repository access status: `backblaze-labs/b2-native-api-docs` still
did not resolve for the authenticated user on the latest recheck (2026-09-01,
via `gh repo view` and `gh search repos`), so upstream handoff remains blocked.

Latest recheck commands and observed outputs:

```sh
$ gh repo view backblaze-labs/b2-native-api-docs --json nameWithOwner,url,description,isPrivate
GraphQL: Could not resolve to a Repository with the name 'backblaze-labs/b2-native-api-docs'. (repository)

$ gh search repos "b2 native api docs owner:backblaze-labs" --json fullName,url,description --limit 20
[]
```

## Decision

Do not change SDK types from generated native API docs alone. Keep the SDK's
current contracts unless they are contradicted by live API validation or a more
authoritative Backblaze source schema.

Keep live integration guardrails for the three tracked shapes in the gated live
integration suite:

- `tests/integration/live-contracts.test.ts` asserts that live `b2_copy_file`
  returns one plain file-version object, not an array.
- Separate tests assert that live bucket update and list responses expose
  `lifecycleRules` as arrays.
- Separate tests assert that live bucket update and list responses expose
  `replicationConfiguration` as an authorization wrapper. Request shapes remain
  the direct `ReplicationConfiguration` object documented by the Backblaze Cloud
  Replication native API guide.

Validation source and result for all three shapes: confirmed by the same-repo
`Integration (real B2)` pull request workflow for PR
[#271](https://github.com/backblaze-labs/b2-sdk-typescript/pull/271), run
[#32792497383](https://github.com/backblaze-labs/b2-sdk-typescript/actions/runs/32792497383).
Both credentialed matrix jobs passed:

- [Node 22.18.0](https://github.com/backblaze-labs/b2-sdk-typescript/actions/runs/32792497383/job/97636785069)
  passed all five `native API docs drift guardrails` tests, including
  `b2_copy_file`, both `lifecycleRules` checks, and both
  `replicationConfiguration` checks.
- [Node 24](https://github.com/backblaze-labs/b2-sdk-typescript/actions/runs/32792497383/job/97636785154)
  passed the same live guardrail tests.

Run the following with live credentials when revalidating future native API docs
drift:

```sh
B2_APPLICATION_KEY_ID=... B2_APPLICATION_KEY=... \
  pnpm exec vitest run tests/integration/live-contracts.test.ts --config vitest.integration.ts
```

## Resolved questions

1. Generated docs are not sufficient evidence for a breaking SDK type change.
2. Live contract tests are the recorded validation and regression guard for
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
