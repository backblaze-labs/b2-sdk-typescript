# Migration guide

This guide covers the breaking changes introduced while aligning the SDK's
TypeScript surface with Backblaze B2's **v4** native API (the `v0.4.0` line,
tracked in [#193](https://github.com/backblaze-labs/b2-sdk-typescript/issues/193)).

Because the SDK is pre-1.0 with no stable external compatibility guarantee yet,
the v4 response-shape corrections shipped as **direct breaking changes** rather
than deprecated `v3`-shaped mirrors. Each section below explains what changed and
how to update your code. Every breaking change is also flagged `BREAKING` in
[`CHANGELOG.md`](./CHANGELOG.md).

## Wire routes: `/b2api/v3` → `/b2api/v4` (no action required)

All SDK-built native storage URLs now use the published `/b2api/v4` route, built
from a single centralized policy in the raw URL builder ([#104]). `RawClient`
method signatures are unchanged, the authorization token is version-agnostic, and
B2 accepts both routes, so this is runtime-compatible — **no caller changes are
needed**. Read/list endpoints continue to send POST JSON.

## Bucket metadata is capability-filtered and wire-accurate

B2 returns several bucket fields wrapped in a `{ isClientAuthorizedToRead, value }`
envelope, so a caller without the relevant read capability cannot distinguish
"not configured" from "not allowed to see it." The SDK now models these exactly,
and reads fail closed (`value` is `null`) when unreadable.

### `BucketInfo.replicationConfiguration` ([#211])

`replicationConfiguration` changed from a bare `ReplicationConfiguration` to the
wrapped shape. `Bucket.getReplication()` returns the same wrapper. Request shapes
(`CreateBucketRequest` / `UpdateBucketRequest`) still take the bare
`ReplicationConfiguration`.

```ts
// Before
const rules = bucket.info.replicationConfiguration.asReplicationSource

// After
const replication = bucket.info.replicationConfiguration
if (replication.isClientAuthorizedToRead) {
  // value is null when replication is not configured
  const rules = replication.value?.asReplicationSource
}
```

### `BucketInfo.defaultServerSideEncryption` ([#210])

`defaultServerSideEncryption` changed from a bare `EncryptionSetting` to the same
wrapped shape. When readable, an unset default is B2's `{ mode: null, algorithm: null }`
no-encryption wire shape. On **requests**, `createBucket` / `updateBucket` now
accept `BucketDefaultServerSideEncryptionSetting` (`SseB2Setting | NoEncryption`)
and reject SSE-C, which B2 cannot use as a bucket default.

```ts
// Before
const sse = bucket.info.defaultServerSideEncryption // EncryptionSetting

// After
const sse = bucket.info.defaultServerSideEncryption
if (sse.isClientAuthorizedToRead) {
  // value: BucketDefaultServerSideEncryption | null
  const mode = sse.value?.mode // null when the bucket has no default encryption
}
```

### `BucketInfo.defaultRetention` removed ([#41])

B2 does not return a top-level default-retention field, so `BucketInfo.defaultRetention`
was removed. Read the nested field instead, or use the facade. An unset default is
`{ mode: null, period: null }`, so handle a `null` mode rather than
`BucketRetentionMode.None`.

```ts
// Before
const dr = bucket.info.defaultRetention

// After
const dr = bucket.info.fileLockConfiguration.value?.defaultRetention
// or, via the facade (undefined when file-lock configuration is unreadable):
const dr2 = await bucket.getDefaultRetention()
if (dr2 && dr2.mode === null) {
  // no default retention configured
}
```

### Bucket type request/response contracts are separate ([#107])

`BucketInfo.bucketType` is now the open `BucketResponseType`
(`KnownBucketResponseType | (string & {})`), which adds the response-only
`'shared'` value and tolerates future B2-added types. Exhaustive `switch`
statements over a **response** bucket type now need a `default` case. Create/update
**requests** still accept only the settable `BucketType`
(`allPublic` / `allPrivate` / `snapshot` / `restricted`).

`ListBucketsRequest.bucketTypes` (and the `B2Client.listBuckets` filter option)
changed from `BucketType[]` to `BucketTypesFilter`
(`readonly ['all'] | readonly BucketListType[]`).

```ts
// Before
switch (bucket.info.bucketType) {
  case 'allPublic': /* ... */ break
  case 'allPrivate': /* ... */ break
}
await client.listBuckets({ bucketTypes: ['allPrivate'] })

// After
switch (bucket.info.bucketType) {
  case 'allPublic': /* ... */ break
  case 'allPrivate': /* ... */ break
  default: /* 'shared' and future B2 types */ break
}
await client.listBuckets({ bucketTypes: ['all'] }) // or ['allPrivate', 'shared', ...]
```

## Event notification custom headers ([#189])

`EventNotificationRule.targetConfiguration.customHeaders` is now the documented
array of `{ name, value }` objects instead of a lookup record. Two helpers convert
between the shapes.

```ts
import {
  recordToNotificationCustomHeaders,
  notificationCustomHeadersToRecord,
} from '@backblaze-labs/b2-sdk'

// Before
customHeaders: { 'X-My-Header': 'value' }

// After
customHeaders: [{ name: 'X-My-Header', value: 'value' }]
// migrate existing record-shaped data:
customHeaders: recordToNotificationCustomHeaders({ 'X-My-Header': 'value' })
// convert a response back to a lookup:
const lookup = notificationCustomHeadersToRecord(rule.targetConfiguration.customHeaders)
```

## List endpoints model folder and hide entries as a discriminated union ([#191])

Listing results are now precisely typed so a virtual folder row is never confused
with a file version:

- `FileVersion.action` narrowed from `FileAction` to `ConcreteFileAction`
  (a folder row is no longer a `FileVersion`).
- `ListFileNamesResponse.files` is `readonly ListedFileVersion[]` and never
  includes hide markers.
- `ListFileVersionsResponse.files` is `readonly ListedConcreteFileVersion[]`
  (`ListedFileVersion | ListedHideFileVersion`).
- The `*WithDelimiter` responses add `FolderFileVersion` rows, which have
  `fileId: null` and `contentType: null`.
- `Bucket.unhideFile()` returns `ListedHideFileVersion | null`.
- `B2SyncPath.allVersions` is `ListedConcreteFileVersion[]`.

Pass a `delimiter` to opt into the folder-aware overloads on
`RawClient.listFileNames` / `listFileVersions` and the `Bucket` facades; the
non-delimiter calls reject folder / null-id rows before returning them.

```ts
// After — narrow before reading fields a folder row does not have
for await (const entry of bucket.paginateFileNames({ delimiter: '/' })) {
  if (entry.fileId === null) {
    // FolderFileVersion — a virtual folder prefix
    continue
  }
  // ListedFileVersion — a real file
  console.log(entry.fileId, entry.contentType)
}
```

## Widened response types (narrow before use)

A few v4 shapes cannot be dual-fielded and are documented here rather than mirrored.
Enable stricter TypeScript settings and narrow before accessing these:

- **File responses** — `fileRetention`, `legalHold`, and `serverSideEncryption`
  are now optional (may be `undefined`) on file metadata ([#41]).
- **Folder / hide entries** — `fileId` and `contentType` are `null` ([#191]).
- **Retention mode** — `mode` is nullable (`null` when unset) on response
  metadata ([#107]).
- **Removed** the phantom top-level bucket `defaultRetention`; read the nested
  `fileLockConfiguration.value?.defaultRetention` instead ([#41]).
- **`BucketInfo.bucketType`** widened to the open `BucketResponseType` for the
  `'shared'` and future values ([#107]).

[#41]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/41
[#104]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/104
[#107]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/107
[#189]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/189
[#191]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/191
[#210]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/210
[#211]: https://github.com/backblaze-labs/b2-sdk-typescript/issues/211
