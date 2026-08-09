# ADR 0001: Partner and Computer Backup module architecture

Status: Accepted

Date: 2026-08-08

Issue: #160, <https://github.com/backblaze-labs/b2-sdk-typescript/issues/160>

## Context

The SDK is currently one zero-dependency isomorphic package with subpath exports for storage-facing modules and shared infrastructure such as `HttpTransport`, `RetryTransport`, `UrlGuard`, the `B2Error` hierarchy, encoding helpers, streams, and `B2Simulator`.

Storage authorization types are intentionally tied to `apiInfo.storageApi` through `AuthorizeAccountResponse` and `AccountInfo`. The simulator also has one storage-oriented issued-token and endpoint-capability model. Partner API and Computer Backup support need an architecture decision before those surfaces add public types and runtime behavior.

## Decision

Add Partner API and Computer Backup as new subpath exports in the existing package:

- `@backblaze-labs/b2-sdk/partner`
- `@backblaze-labs/b2-sdk/backup`

Do not create a second npm package, and do not add partner or backup methods to the storage `RawClient` or `B2Client`. Keeping one package preserves the current zero-dependency, isomorphic distribution model and lets the new surfaces reuse shared transports, retry behavior, URL guarding, errors, encoding, streams, and simulator utilities without creating duplicated infrastructure.

Model Partner API authorization as a distinct `authorizePartner` flow. It uses the Master Application Key HTTP Basic exchange against `b2_authorize_account`, but stores the result in a separate `PartnerAccountInfo` abstraction instead of the storage `AccountInfo`. The partner account state must represent partner response fields such as `groupsApiUrl` and `backupApiUrl` without weakening the existing storage types that are hard-bound to `apiInfo.storageApi`.

The backup module reuses the partner auth store type because it uses the same partner token, but it targets `backupApiUrl` as its base URL. The backup module must not be implemented as a namespace inside `/partner`; `/partner` and `/backup` are separate public subpaths because the wire model exposes separate `groupsApiUrl` and `backupApiUrl` endpoints and the products have distinct API surfaces.

## Open questions

1. Partner authorize path version: use `/b2api/v3/b2_authorize_account` for `authorizePartner` initially because the Partner API documentation shows v3. Keep the version localized to the partner authorizer so it can move to v4 later if Backblaze publishes or ratifies v4 partner authorization behavior.
2. Shared storage and partner authorization: keep storage `authorize()` and partner `authorizePartner()` separate. Even though both call `b2_authorize_account`, their response shapes, endpoint roots, capability assumptions, and account-info stores are different enough that sharing one token store would blur product boundaries and weaken existing storage type guarantees.
3. Area labels: use repository labels `area: partner` and `area: backup` with the same color and description style as the existing `area:*` labels. Apply them to follow-on implementation work.

## Consequences

Partner and backup implementation issues should reference this ADR and issue #160. Known follow-on issues at the time of this decision are #161, #162, #163, #164, #165, #166, #167, #168, #169, #170, #171, and #172.

Follow-on work should include:

- adding package exports for `/partner` and `/backup`
- implementing `PartnerAccountInfo`, `authorizePartner`, and partner response types
- wiring `/backup` clients to use `PartnerAccountInfo` and `backupApiUrl`
- extending simulator token and capability modeling for partner and backup endpoints without regressing storage strict-auth behavior

This decision intentionally records architecture only. It does not add public runtime exports or placeholder modules before the product API shapes are implemented.
