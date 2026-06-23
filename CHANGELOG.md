# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **New `sha1` sync compare mode.** `CompareMode` now accepts `'sha1'`, and `SyncPath` exposes an optional `contentSha1` field plus `contentSha1State` for custom scanners that can supply explicit trust state. The synchronizer hashes local files only when cheaper metadata cannot already prove drift and compares against B2 SHA-1 metadata. B2's verified single-part `contentSha1` can prove equality; multipart `fileInfo.large_file_sha1` and `unverified:<hex>` values are untrusted hints and are verified by hashing the selected B2 version before they can suppress a transfer. Files whose SHA-1 is genuinely unavailable, or whose untrusted B2 bytes cannot be verified before the configured deadline or byte ceiling, are skipped with a surfaced event rather than failing the whole run. SHA-1 comparison uses bounded workers, dry-runs still hash matching-size local files but do not download B2 bytes for untrusted metadata, and `compare` events report local hash reads in `bytesHashed` plus B2 verification reads in `bytesVerified`. Local hashing rejects non-regular files and bounds reads to the scanned size; local and B2 SHA-1 reads use `sha1ReadTimeoutMillis` as an idle/no-progress timeout with a bounded default. Untrusted B2 verification is also bounded by selected-version byte length and `sha1VerificationTimeoutMillis`, with `sha1VerificationMaxBytes` available as a lower per-file byte ceiling. The SDK does not cache untrusted B2 verification results across runs, so unchanged multipart objects can incur full-object B2 download reads every `sha1` sync. Custom scanners can use the exported `selectB2ComparableSha1()`, `parseSyncContentSha1()`, `syncSha1StateOf()`, `untrustedSha1()`, `isUntrustedSha1()`, and `untrustedSha1Prefix` helpers to mark or inspect SHA-1 metadata without duplicating sentinel strings. This is an accidental drift detector, not a cryptographic tamper guarantee. Closes #29.
- **S3-compatible AWS Signature Version 4 presigned URLs and release hardening.** New `presignS3GetObjectUrl()` and `presignS3PutObjectUrl()` helpers generate real S3-compatible presigned URLs for B2 without passing application-key secrets to runtime peer packages. PUT presigns can bind `Content-Type`, `Content-Length`, and metadata headers for browser / third-party uploads. Trusted server code can opt into intentionally inline or browser-executable response overrides by passing `trustedUnsafeS3PresignOptIn` to `allowInlineResponseContentDisposition`, `allowBrowserExecutableResponseContentType`, or `allowBrowserExecutableContentType`; plain booleans from request JSON are ignored. PUT presigned URLs are replayable until expiry and retries can create duplicate file versions if B2 stored the object but the client missed the response; use unique keys, reconcile by listed file IDs/checksums, and configure lifecycle/version cleanup when needed. The shorter `presignPutObjectUrl()` name remains as a deprecated alias for pre-release adopters. The existing B2-native `presignGetObjectUrl()` positional helper remains as a deprecated compatibility alias; use `createNativeDownloadAuthorizationUrl()` when you intentionally want a B2 download-authorization-token URL. The release workflow now verifies a packed artifact before publishing it with npm trusted publishing and GitHub Release artifact reuse.
- **Sync include/exclude filters.** `SyncOptions` now accepts `include` and `exclude` filters using SDK glob strings or best-effort guarded regular expressions, with exported `SyncFilterOptions` and `SyncFilterPattern` types for reusable configuration. Filters apply to both local and B2 sides during sync, and `SyncFolder.scan()` accepts the same filter object for standalone scans. Glob filters use the SDK segment dialect (`*` / `?` within one segment, whole-segment `**` across directories, slash-less basename/ancestor matching) and excludes win over includes. RegExp acceptance is a safety heuristic whose exact accepted subset may change as protections tighten; paths beyond the RegExp input guard are skipped whenever any RegExp filter is configured, including exclude-only RegExp deny-lists.
- **B2 sync scan diagnostics.** `SyncFolder.scan()` accepts `SyncScanOptions.onSkip`, and `synchronize()` surfaces built-in scanner diagnostics as `skip` events with exported `SyncSkipReason` values for objects outside the configured prefix, unsafe relative names, local-filesystem-unsafe names, normalized or local-canonical path collisions, filesystem read errors, paths beyond the RegExp input guard, and aggregated scanner diagnostic overflow. Raw B2 prefixes preserve backslashes as key characters; pass `/` explicitly for slash-delimited prefixes. Custom scanners can use the exported `pathPassesSyncFilters`, `directoryMayContainSyncPaths`, `filterSyncPaths`, `literalPrefixForSyncFilters`, and `pathSkippedByRegExpInputLimit` helpers to match the SDK filter dialect. Built-in scans sort before yielding and B2 scans group listed versions before yielding, so exclude filters and non-literal includes do not bound the scanner memory footprint. `SyncOptions.maxScanEntries` / `SyncScanOptions.maxScanEntries` provide a defined scan-limit failure mode for unexpectedly large scans; B2 scans count every listed file-version record, including versions later skipped by prefix, safety, or filter checks, while local and fallback scans count retained sync paths. Pass `Infinity` only when the process heap is sized for the full result set; raising the limit increases peak scanner memory.
- **Raw JSON request options bags are public.** `RawRequestOptions` is exported, and `RawClient.getUploadUrl` / `getUploadPartUrl` accept options bags for `signal` and `retry`. The older `JsonPostOptions` export remains as a deprecated alias for source compatibility.
- **Multipart resume exposes public diagnostics and tuning controls.** `ResumeFileIdMismatchError`, `onResumeCandidateRejected`, `onResumePartReused`, `ResumeCandidateRejectedEvent`, `ResumeCandidateRejectedReason`, `ResumePartReusedEvent`, `ResumePartReusedListener`, and the `resumeMaxListPages` / `resumeMaxPartCandidates` / `resumeMaxPartPages` / `resumeDiscoveryTimeoutMs` options are exported or available on high-level upload APIs.
- **Public B2 response metadata types are exported.** New response-facing types include `PublicEncryptionSetting`, `SseCPublicSetting`, `NoEncryptionWireSetting`, `ReadableFileRetention`, `ReadableLegalHold`, and `UnfinishedLargeFileMetadata`.
- **`FileSource` for Node.js uploads from local paths.** `FileSource.fromPath()` exposes a filesystem-backed `ContentSource` that streams and slices local files by byte range, letting large uploads and sync transfers use multipart upload without first reading the entire file into memory. It validates the opened regular-file identity and rejects reads if the path is replaced, truncated, or modified during upload.

### Changed

- **Sync error summary wording now reports total sync errors.** The terminal summary event changed from `N action(s) failed` to `N sync error(s) occurred` because SHA-1 preparation failures are surfaced alongside transfer/action failures.
- **Sync concurrency validation is now strict.** `SyncOptions.concurrency` must be a positive integer; invalid values such as `0`, negative numbers, `NaN`, or fractions throw `RangeError` before sync scanning begins.
- **Sync scan errors now preserve readable-file progress.** Non-root local scan errors are surfaced as per-path `error` events while readable siblings continue; if any scan error occurs, destination-only delete/orphan actions are skipped to avoid removing paths hidden by scan failures.
- **`compare` events now expose `bytesHashed`.** In `sha1` mode, local bytes read for hashing are reported as `compare.bytesHashed`; `compare.size` remains `0` for compatibility with the previous metadata-only compare event shape. At the type level, `compare` is now represented by `SyncCompareEvent` rather than `SyncActionEventType`, so TypeScript consumers that narrow on action-event types should handle compare events separately.
- **S3 region derivation now fails closed for custom endpoints.** `createS3ClientConfig()` and the S3 presign helpers derive the region from standard `s3.<region>.backblazeb2.com` endpoints. Custom, proxied, or non-standard endpoints must pass `region` explicitly and should call `createS3ClientConfig()` during startup or deployment health checks before serving traffic; the SDK no longer falls back to `us-west-004`, which could mis-sign requests.
- **B2-native download authorization URLs now use B2 file-name path encoding.** The explicit `createNativeDownloadAuthorizationUrl()` helper preserves `/` path separators in file names and percent-encodes each segment, matching B2 download URL conventions. The deprecated `presignGetObjectUrl()` compatibility alias keeps the legacy slash-escaped output format and permissive string-building behavior until a planned breaking release. The explicit helper requires an `https:` Backblaze download origin without userinfo, path, query, or fragment, rejects unsafe bucket names, control characters, or non-integer / negative `validDurationInSeconds`, and builds the bearer URL from the parsed origin rather than raw-concatenating the caller's `downloadUrl`.
- **S3 presigned GET response overrides fail closed for browser-executable responses.** `presignS3GetObjectUrl()` now rejects unsafe `responseContentType` overrides such as HTML, SVG, XML, and JavaScript media types, malformed media types, `inline` response dispositions, and control characters in response header overrides unless trusted server code passes `trustedUnsafeS3PresignOptIn` to the unsafe opt-in option. S3 object keys with `.` or `..` path segments cannot be presigned safely because common URL parsers normalize them before sending; rename those objects, use a B2-native download authorization URL where appropriate, or proxy the download through a trusted server. The built-in active-content checks are best-effort denylists, not a complete browser security policy; callers should allow-list safe response headers before signing URLs for untrusted users. Presigned URL validity depends on the signing host's clock, so check clock skew when downstream URL use returns SigV4 403s.
- **S3 presigned PUT helpers fail closed for executable content types and HTTP endpoints.** `presignS3PutObjectUrl()` rejects cleartext `http:` endpoints before emitting bearer URLs and rejects malformed or browser-executable bound `Content-Type` values such as HTML, SVG, XML, and JavaScript media types unless trusted server code passes `trustedUnsafeS3PresignOptIn` to `allowBrowserExecutableContentType`. Omitting `contentType` still lets the URL holder choose any B2-accepted content type, including executable browser content. The built-in media-type check is a best-effort denylist and does not replace an application allow-list or response headers such as `X-Content-Type-Options: nosniff`.
- **Redacted URL error messages now remove every path segment.** SDK-wide redacted URLs keep the origin but collapse non-empty paths to `/...`, and continue removing userinfo, query strings, and fragments before interpolation into errors.
- **Response encryption metadata now uses public B2 response shapes.** `FileVersion.serverSideEncryption`, `UploadPartResponse.serverSideEncryption`, and unfinished-large-file encryption metadata are typed as `PublicEncryptionSetting`, so SSE-C response values do not expose customer-key material and B2's `{ mode: null, algorithm: null }` no-encryption wire shape is represented. This is a TypeScript contract change for callers that reused response encryption objects as upload options; migrate by choosing an explicit upload setting such as `SSE_B2`, `SSE_NONE`, or `sseCustomer(...)`.
- **`ListUnfinishedLargeFilesRequest.startFileId` is documented as inclusive.** The simulator and real-B2 integration coverage now match the B2 cursor behavior used by `b2_list_unfinished_large_files`; callers with hand-written pagination loops should avoid assuming the previous exclusive wording.
- **Multipart part uploads retry lost response-body reads by default.** Single-file uploads still disable ambiguous response-body retries unless `retryResponseBodyFailures: true` is set, but multipart part and write-stream uploads default to retrying because re-posting the same part number is idempotent and B2 keeps the latest part write before `finishLargeFile`, including SSE-B2 encrypted parts. Pass `retryResponseBodyFailures: false` to opt back out. Fresh upload URL recovery for 408/5xx, stale upload URLs, expired or invalid upload tokens, and network failures is a public upload-layer behavior; bound it with `retry.maxRetries` and observe it with `onUploadRetry`.

### Deprecated

- **RawClient upload URL positional overloads are deprecated.** The legacy `signal` / `retry` positional arguments on `getUploadUrl` and `getUploadPartUrl` remain source-compatible, but callers should use the `RawRequestOptions` options-bag form.

### Fixed

- **Multipart resume now verifies unfinished large-file identity before reuse.** Automatic `resume: true` same-name discovery remains supported, and explicit `resumeFileId` remains the targeted path for callers that deliberately trust one unfinished large-file ID. Both paths check upload options, caller file info, freshly fetched effective bucket-default encryption and readable default retention, explicit Object Lock settings, and uploaded part lengths before reuse; unreadable bucket default retention, candidate retention, or candidate legal-hold fields fail closed. Discovery is bounded by page/candidate limits and by `resumeDiscoveryTimeoutMs` only when supplied, or by the caller's abort signal. Automatic resume reuploads planned parts, while explicit resume recomputes local part SHA-1 and skips only parts whose local digest matches B2's part SHA-1. The SDK does not write managed resume keys into durable file metadata. SSE-C is excluded from automatic and explicit resume because B2 does not expose customer-key identity, and incompatible unfinished uploads are left for caller cleanup or lifecycle rules.
- **Sync transfers now stream large files without whole-file buffering.** Local-to-B2 sync uses `FileSource` so multipart uploads read file ranges from disk, and B2-to-local sync streams downloads into a private managed staging directory, verifies the completed byte count, then atomically renames into place only after the stream and checksum checks succeed. Download paths reject traversal, backslashes, Windows-dangerous names, symlink escapes, and stalled body reads before writing, remove failed staging files, and propagate abort signals to in-flight bucket upload/download calls. Operators syncing active logs or databases should retry after writers quiesce if a file changes during upload; the SDK surfaces that as `FileSource file changed after validation`.
- **Sync local writes and deletes are hardened against symlink swaps.** B2-to-local downloads now stream into a private managed staging directory and rename into place only after destination identity checks pass, so a leaf symlink swapped in after path validation is replaced rather than followed. Local-to-B2 uploads reopen scanned files with no-follow semantics and verify the opened file remains inside the source root before reading. Local delete paths are revalidated immediately before unlinking. Local sync roots that contain symlinked path components are rejected for downloads and local deletes; the remaining threat model assumes no concurrent untrusted process can replace already-validated parent directories inside the sync root during the final rename or unlink window.
- **Sync action results stream incrementally after a complete inventory.** `synchronize()` now waits for source and destination inventories to complete successfully before starting mutating actions, then yields upload, download, copy, delete, hide, skip, and per-action error events as actions settle. This prevents a streaming scanner/listing failure from committing partial mutations based on an incomplete inventory. Closing the iterator early aborts and awaits started actions before `return()` settles. The terminal aggregate error event includes `failureCount`, up to 100 `failedPaths`, and `failedPathOmittedCount` when more paths were omitted.
- **Sync aggregate error paths are distinct.** Repeated failures for the same sync-relative path are counted in `failureCount` but appear only once in the bounded `failedPaths` list, preserving room for additional distinct paths.
- **Sync transfers honor abort signals and stalled downloads fail fast.** Upload, download, B2 copy, hide, remote delete, and local delete actions receive the sync action abort signal for in-flight cancellation, and built-in scanners check `SyncOptions.signal` during enumeration. B2-to-local download body reads now use `downloadIdleTimeoutMillis` (default 60 seconds) so a half-open response stream releases its concurrency slot with an error instead of hanging indefinitely.
- **Sync B2 mutation targets are prefix-validated.** Upload replacement, hide, and remote-delete actions no longer trust a custom B2 destination scanner's raw `selectedVersion.fileName` unless it belongs to the configured prefix and normalizes back to the reported sync path.
- **Sync scanners keep read-only scan semantics and tolerate B2-reserved basenames.** Local scans no longer delete `.b2sdk-*.partial`-looking files, including during dry runs or when the local tree is the source. Download temp cleanup is limited to files carrying the current sync run's owner token, so concurrent syncs sharing a destination cannot remove each other's active partial downloads. B2 scans no longer reject Windows-reserved basenames such as `aux.txt` at scan time, so B2-to-B2 syncs preserve those valid B2 object names; B2-to-local sync skips Windows-dangerous names and case/Unicode-canonical local path collisions before local writes.
- **B2 include-prefix pushdown preserves backslash-normalized keys.** B2 listing prefixes derived from include globs no longer narrow past a normalized path separator, so a raw key such as `docs\readme.md` can still be listed and filtered as `docs/readme.md` instead of being silently hidden by a `docs/readme.md` include.
- **`ActionFactory` has a B2SyncPath-aware copy hook while preserving `copy(source, destRelativePath)`.** Custom action factories continue receiving sync-relative destination strings from `copy()`. B2SyncPath-aware implementations can add `copyB2Path(source, dest)` and use `dest.selectedVersion.fileName` when a raw B2 prefix or normalized sync path differs from the stored destination object key.
- **`ActionFactory` has a B2SyncPath-aware hide hook while preserving `hide(path: string)`.** Custom action factories can continue implementing `hide(path: string)`; B2SyncPath-aware implementations can add `hideB2Path(path: B2SyncPath)` and use `path.selectedVersion.fileName` when they need the stored B2 object key. This keeps hide actions correct when a raw B2 prefix or normalized sync path differs from the object name without breaking existing custom factories.
- **`realm: 'staging'` now resolves to the staging authorize endpoint.** It previously
  aliased production (`https://api.backblazeb2.com`), so callers who explicitly
  configured staging silently authorized against production. Existing
  `FileAccountInfo` auth caches created with the old staging alias are ignored
  once bound to the new staging realm so a stale production authorization
  response is not reused. Persisted `FileAccountInfo` entries are also bound to
  the configured application key ID so a shared cache path cannot replay auth
  written by another key. Legacy caches without key-binding metadata are ignored
  after binding and will re-authorize once without truncating the shared cache
  file. During a rolling deploy, old and new code resolve `realm: 'staging'` to
  different hosts; avoid staging-realm traffic during the upgrade window if that
  split matters for the deployment. For shared `FileAccountInfo` paths, prefer
  one cache path per resolved realm and application key, and wire `onDiscard`
  during the upgrade to observe any cache entries ignored by the new binding.
  The new `https://api.backblaze.net` staging host matches the Backblaze Python
  SDK realm map. This is a runtime host change for users of `realm: 'staging'`.
  Closes #34.
- **Realm URLs are validated before authorization sends credentials.** Custom
  realm values must be absolute HTTPS URLs, except loopback IP literal HTTP URLs
  used for local testing. Non-URL strings, unsupported schemes, malformed URLs,
  URLs with userinfo/query/fragment, hostnames such as `localhost`, and
  non-loopback plaintext HTTP now throw `B2RealmConfigurationError` before the
  application key is sent. `getRealmUrl()` remains a resolver-only helper:
  unknown strings are returned unchanged so callers can resolve custom aliases,
  and validation happens at authorization time. Accepted custom HTTPS hosts are
  trusted with the application key, so do not derive `realm` from untrusted
  input. Loopback HTTP sends application-key credentials unencrypted and is
  intended only for local simulator or proxy testing.
- **Redirect handling is now guard-checked in `FetchTransport`.** Same-origin
  GET/HEAD redirects are followed by default after each target passes the SSRF
  guard. POST redirects and cross-origin redirects surface as non-retryable
  `B2RedirectError`, exported from the package root and
  `@backblaze-labs/b2-sdk/errors`, with request and Location URLs sanitized
  before they appear in error messages. Pass `followSameOriginRedirects: false`
  to block even same-origin GET/HEAD redirects. Browser and edge runtimes may
  report cross-origin manual redirects as opaque redirects with no readable
  Location, so those remain blocked. Monitor or catch `B2RedirectError` during
  rollout if your deployment might depend on CDN, proxy, or regional redirect
  behavior.
- **Downloads now verify whole-file SHA-1 checksums when B2 provides a verifiable digest.** Full-body GET downloads wrap the response stream and throw `ChecksumMismatchError` if the bytes do not match `X-Bz-Content-Sha1`; parallel ranged downloads verify the assembled stream in order and reject cross-range header disagreements. HEAD requests, partial range GETs, and files whose download SHA-1 is unavailable (`none` / `null`) continue to skip verification because no matching whole-body digest exists. Closes #25.
- **`B2Simulator` `b2_copy_file` now honors `metadataDirective`, `contentType`, `fileInfo`, and `range`.** A `COPY` directive (default) preserves the source's content type and file info; `REPLACE` applies the request's (and is rejected with `400 bad_request` when `contentType` is missing, matching real B2, with the supplied `fileInfo` validated). A byte `range` copies only the requested slice and recomputes its SHA-1, rejecting an unsatisfiable range with `416`. Previously the simulator ignored all four and always did a whole-file COPY.
- **Retry transient 5xx responses.** `internal_error` / HTTP 500 (and 502 Bad Gateway, 504 Gateway Timeout) are now classified as retryable, so `RetryTransport` retries them with backoff alongside 408/429/503. Previously a transient 500 surfaced as an immediate, non-retryable failure. 501 Not Implemented remains non-retryable (deterministic). Upload endpoints (`b2_upload_file` / `b2_upload_part`) do not retry pod failures in place: they are URL-pinned, so retryable pod failures now bubble to the upload layer for fresh-URL recovery. HTTP 429 upload throttling still backs off on the same upload URL to avoid amplifying account-level rate limits with extra URL fetches.
- **Uploads now retry transient failures with fresh upload URLs.** Single-file uploads, multipart parts, stream-backed multipart uploads, and `createWriteStream()` evict a failed upload URL, back off with one upload retry budget, fetch a fresh upload URL / part URL without nested transport retries, and retry there for 408/5xx, stale upload URLs, expired or invalid upload tokens, and multipart upload network failures. New public `onUploadRetry` and `retryResponseBodyFailures` options are available on high-level upload APIs, and `UploadRetryEvent` / `UploadRetryListener` are exported from the package root. `onUploadRetry` reports file name, part number, attempt, delay, and classified error before each retry. Direct raw upload endpoint calls no longer receive nested transport retries for upload-pod network failures; use the high-level upload APIs for fresh-URL recovery. If a single-file upload POST succeeded but the response was lost, retrying can create a duplicate file version, so single-file response-body failures and upload POST network errors do not re-send payloads by default. Set `retryResponseBodyFailures: true` to opt into that at-least-once behavior when availability is preferred over duplicate-version avoidance, and use lifecycle or version-retention rules when buckets need automatic cleanup. During a rolling deploy, older SDK processes may still retry lost response bodies while newer processes report the ambiguous upload as an error; reconcile by comparing returned or listed file IDs and SHA-1 values for the target file name.
- **Correct browser SHA-1 for buffer-backed views.** `sha1Hex`'s WebCrypto path hashed `data.buffer` (the whole backing `ArrayBuffer`) instead of the `Uint8Array` view's `byteOffset`/`byteLength`, so a subarray (e.g. a carved multipart part) produced a wrong digest in browsers and other non-Node runtimes. It now hashes the view directly. (`IncrementalSha1`'s WebCrypto fallback was already correct, since it copies chunks into an exact-sized buffer before hashing; it now passes that buffer directly too, for consistency.) The Node `crypto` path was always correct.
- **`B2Simulator` now verifies upload SHA-1 and persists `fileInfo` across all upload paths.** `b2_upload_file` and `b2_upload_part` recompute the body's SHA-1 and reject a mismatch with `400 bad_request` ("Sha1 did not match data received"), honoring the `none` / `do_not_verify` / `unverified:<hex>` sentinels and the `hex_digits_at_end` trailing-digest mode (the trailing 40 bytes are verified and stripped, not stored as content). `finishLargeFile` verifies each `partSha1Array` entry against the stored part's SHA-1 (rejecting a mismatch with `400 bad_request`). Uploaded `fileInfo` is now persisted for both single-file and multipart (`finishLargeFile`) uploads and returned by `getFileInfo`, list, and `download` (serialized as `X-Bz-Info-*` headers using the same B2 `encodeFileName` encoding the download parser decodes with). Closes gaps where the test backend accepted any hash and silently discarded metadata. `B2Simulator.handleUpload` is now `async`.

## [0.1.0] - 2026-05-28

First public release of `@backblaze-labs/b2-sdk`. Everything below is new in this version.

### Added — security

- **SSRF / URL-substitution guard** in the default `FetchTransport`. After `B2Client.authorize()`, the transport rejects any URL whose host falls outside the realm's parent domain (`backblazeb2.com`, `backblaze.com`) plus user-supplied allow-list entries. Literal IPv4/IPv6 addresses, `localhost`, `metadata.google.internal`, `*.internal`, and `*.local` are rejected unconditionally. New `B2SsrfError` (non-retryable, attaches the offending URL). New public `UrlGuard` class and `deriveAllowedSuffixes()` helper exported from the main entry. See [SSRF guard](README.md#ssrf-guard).
- **`B2ClientOptions.allowedHostSuffixes`** — optional extra hosts merged into the guard's allow-list after authorize, for self-hosted proxies / debugging.
- **Audit-derived regression tests** anchored to specific ecosystem failure modes:
  - `src/upload/resume.safety.node.test.ts` fails if the resume module ever imports `node:fs` (prevents s3up-style on-disk uploadId leak).
  - Concurrency invariants on `UploadUrlPool` (no double-issue, evict-on-held safety, key isolation, 1000-cycle stress).
  - Monotonicity assertion on `onProgress` event sequences during multipart uploads.

### Added — source-level isomorphism

- **`.ts` extensions on every internal relative import.** `tsconfig.json` enables `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`. One source tree now runs unmodified in Node 22+, Bun, Deno (no build step, no `node_modules`, no `npm:` shim), browsers, Cloudflare Workers, and Vercel Edge. Vite rewrites the extensions during build so consumers still see `./foo.js` in dist/.
- **Deno typecheck workflow** verifies the property on every push: `deno check examples/...` resolves `@backblaze-labs/b2-sdk` straight at `../src/*.ts` via `examples/deno.json`. If a `.js` extension ever sneaks back into an internal import, the workflow fails immediately.
- **JSON-imported version constant.** `src/version.ts` does `import pkg from '../package.json' with { type: 'json' }; export const VERSION = pkg.version`. Bumping the package version automatically propagates to the User-Agent header and the published artifact — no separate `src/version.ts` to maintain, no sync script. Rollup tree-shakes the JSON down to a 133-byte module containing only the version field; no devDependency or metadata leak to consumers.

### Added — telemetry & identity

- **Stable, greppable User-Agent.** Format: `b2-sdk-typescript/<version> (typescript; @backblaze-labs/b2-sdk; <runtime>; [os; ][arch])`. Both `b2-sdk-typescript/` (stable product token) and `@backblaze-labs/b2-sdk` (npm package name) are part of the documented contract — log queries can match either. Runtime detection covers Node, Bun, Deno, and browser; OS + arch reported on non-browser runtimes. Custom `userAgent` from `B2ClientOptions` is prepended verbatim. New exported constants `SDK_PRODUCT` and `SDK_PACKAGE` from `@backblaze-labs/b2-sdk`.

### Added — simulator fidelity & test seams

- **B2 spec input validation in the simulator.** `validateBucketName`, `validateFileName`, `validateFileInfo`, `validateBucketInfo`, and `validateMaxCount` enforce the limits B2 documents (6-63 char bucket name with `b2-` reserved-prefix rule, 1024-byte UTF-8 file-name cap, 2048-byte fileInfo / bucketInfo budgets, per-endpoint `maxFileCount` ceilings). Wired into every state-touching handler. Limit constants (`BUCKET_NAME_MIN/MAX`, `FILE_NAME_MAX_BYTES`, `FILE_INFO_TOTAL_MAX`, `BUCKET_INFO_MAX_KEYS`, etc.) are re-exported from `@backblaze-labs/b2-sdk/simulator` for tests that want to parameterise around the documented caps.
- **Opt-in strict-auth mode.** `new B2Simulator({ strictAuth: true })` enforces application-key capabilities, bucket scoping, prefix scoping, and auth-token expiry on every request (including upload + download paths). Unknown tokens return `401 bad_auth_token`; expired tokens return `401 expired_auth_token`; missing capabilities return `403 unauthorized`. Default remains permissive so existing tests are unaffected.
- **Virtual clock for expiry tests.** `B2Simulator.advanceTime(ms)` fast-forwards the simulator's internal clock so `authTokenTtlMs` expiry paths can be exercised without `setTimeout`.
- **Pluggable post-upload hooks.** `onWebhookDeliver` fires after every successful upload / copy / `finishLargeFile` against a bucket with matching event-notification rules; `onReplicate` fires when the bucket is a replication source. Errors thrown from user hooks are routed to the optional `onHookError` (otherwise swallowed — a buggy listener never masks API success). `B2Simulator.flushHooks()` is a deterministic test seam: awaits every pending hook to settle before assertions.
- **Wire-level edge cases.** `parseRangeHeader` returns a tagged result (`ok` / `unsatisfiable` / `malformed`); the simulator now returns `206` with the documented `Content-Range: bytes <start>-<end>/<total>` header and `416 Range Not Satisfiable` (with `Content-Range: bytes */<total>`) when the start offset is past EOF. Realistic 24-hex IDs (`b2_bucket_<hex>`, `4_z<hex>`) replace the previous 12-digit stand-in. `b2_finish_large_file` validates `partNumber ∈ [1, 10000]` and that `partSha1Array.length === uploadedParts.length`. `b2_delete_key` evicts every outstanding auth token issued from the revoked key.
- **Fault injection.** `B2Simulator.injectFailure({ on, status, code, message, count, skip, retryAfter })` registers a synthetic failure that fires on every matched request until its `count` budget is spent. Returns a `FaultHandle` whose `.clear()` retires that specific registration. `clearFaults()` removes every fault. Faults run before any real handler, so a matched request never touches in-memory state.

### Added — CI & examples

- **`real-examples` CI job** runs every documented `npx tsx examples/...` command against a real B2 account after the integration suite passes (Node 22 + 24, serialised). The runner asserts content round-trip equality for both `node-download` and `node-backup-cli restore`. A renamed flag, swapped argument order, or stale README command fails CI before reaching users.
- **`smoke-examples` CI job** runs the same examples against an in-memory `B2Simulator` on every push and PR — zero credentials, zero network, zero cost. Exercises the `npx tsx`/`exports`-map resolution path the same way an `npm install`-ed consumer would.
- **Real-B2 integration workflow** (`.github/workflows/integration.yml`) runs the integration suite sequentially across Node 22 + 24 with `max-parallel: 1`, on push, PR, weekly schedule, and `workflow_dispatch`. Defensive `sdk-test-*` bucket sweep at startup absorbs leftovers from crashed runs.
- **Examples Deno + Bun typecheck jobs.** `bunx tsc --noEmit -p examples/tsconfig.json` and `deno check` (via `examples/deno.json` import map) run on every push.

### Changed — lint gate

- **`pnpm lint` now uses `biome check --error-on-warnings`.** Any warning — not just an error — fails CI. The previous 17 baseline warnings (all `lint/suspicious/noExplicitAny` in test mocks) were converted to `as unknown as <RealType>` casts.

### Changed — CI matrix timeouts

- **`LARGE_TEST_TIMEOUT = 60_000`** applied to copy + write-stream tests in `src/copy/copy.test.ts` and `src/upload/stream.test.ts`, matching the existing calibration in `src/upload/upload.test.ts`. macOS GitHub-hosted runners are ~2-3× slower than typical local Macs for the simulator's per-part SHA-1 computation; the previous hardcoded 30 s budget was getting clipped on bad scheduling ticks.

### Added — docs

- **Bundle-size table** in the Quality section, measured per-subpath via Bun's bundler with tree-shaking enabled (main entry: ~9.6 KB gzipped; `/errors`: 670 B gzipped; `/streams`: 801 B gzipped; `/simulator`: 5.3 KB gzipped).
- **Source-isomorphism section** in the README documenting how `deno check examples/` against `src/` works without a build step.
- **Identifying your traffic (User-Agent)** section in the README documents the contract and how to prepend an application prefix.

### Added — isomorphic test coverage

- **Vitest browser-mode test suite** under `pnpm test:browser`. The full test surface (minus `*.node.test.ts` files) runs in real Chromium, Firefox, and WebKit via Playwright. CI parallelizes per engine via `VITEST_BROWSER_INSTANCE`.
- **Isomorphic `B2Simulator`**: `handleRequest` is now `async` and the `b2_copy_part` handler uses the SDK's own `sha1Hex` (Node `node:crypto` lazy-loaded, WebCrypto fallback in browsers). Drops the previous `node:crypto.createHash` top-level import.
- **Pure-JS MD5 fallback** in `EncryptionKey.fromBytes`. When `node:crypto.createHash` isn't available, the SDK computes MD5 in pure JS so SSE-C key construction stays cross-runtime. Verified against three RFC 1321 vectors in both Node and browsers.
- **Lazy `node:fs/promises` and `node:path` imports** inside `src/sync/synchronizer.ts` action closures. The synchronizer module itself loads in browsers (B2-to-B2 sync works in a browser); only local-disk actions throw when invoked outside Node.
- **Test file naming convention**: `*.node.test.ts` is skipped in browser mode. Renamed `src/auth/file.test.ts` → `file.node.test.ts`, `src/sync/scanners/scanners.test.ts` → `scanners.node.test.ts`. Added `src/streams/encryption-key.node.test.ts` for the `util.inspect` redaction assertion.

### Added — robustness

- **Resume support for multipart uploads.** Pass `resume: true` (or an explicit `resumeFileId`) to `uploadLargeFile` or `Bucket.upload`. The engine queries `listUnfinishedLargeFiles` + `listParts` and skips parts whose locally-recomputed SHA-1 matches the server's. New `src/upload/resume.ts` with `findResumeCandidate` and `collectPartSha1s` helpers.
- **Per-range retry in `createParallelDownloadStream`.** Each ranged GET is retried independently with exponential backoff and jitter (default 5 attempts). New `maxRetries` option; a single transient 503 no longer kills the whole transfer.
- **Bulk delete primitives** on `Bucket`:
  - `deleteMany(targets, options?)` — bounded-concurrency delete with per-target error collection
  - `deleteAll({ prefix?, dryRun?, pageSize? })` — async generator that streams `DeleteAllEvent` over every matching file version
- **`bucket.copyLargeFile(options)` orchestrator** (new `src/copy/large.ts`). Server-side multipart copy via `b2_copy_part`. Falls back to single `copyFile` below part-size threshold. Works across buckets.
- **SSE-C key safety helpers.** New `EncryptionKey` class in `src/types/encryption.ts`:
  - `EncryptionKey.fromBytes(rawKey)` computes MD5 internally
  - `EncryptionKey.fromBase64(key, md5)` for browser-precomputed digests
  - Redacts itself in `toJSON()`, `toString()`, and Node's `util.inspect` custom symbol
- **`bypassGovernance` flag** on `bucket.updateFileRetention(..., { bypassGovernance: true })` for shortening governance-mode retention.

### Added — ergonomics

- **`B2Object.createWriteStream(options?)`** returning `{ writable: WritableStream<Uint8Array>, done: Promise<FileVersion> }`. Pipe a `ReadableStream` directly into B2 with multipart-protocol buffering, parallel part uploads, and backpressure.
- **`B2Client.hasCapabilities(needed)`** returns `{ ok, missing }` against `accountInfo.allowed.capabilities`. New `B2InsufficientCapabilityError` (the 13th error subclass) and `CapabilityCheckResult` interface.
- **`bucket.getFileInfoByName(fileName)`** and **`bucket.unhideFile(fileName)`** convenience methods.
- **`FileAccountInfo`** — JSON-file-backed `AccountInfo` (Node-only) under new subpath `@backblaze-labs/b2-sdk/auth/file`. Survives process restart; load() returns silently on missing/corrupt files.

### Added — base

- `B2Client` high-level facade with bucket and key management
- `Bucket` handle: upload, download, list, hide, delete, copy, update, notifications, retention, legal hold
- `B2Object` handle: upload, download, parallel download stream, file info, hide, delete
- `RawClient` with all 37 B2 native API endpoint bindings (including `listParts` and `copyPart` simulator handlers)
- Single-file upload with automatic SHA-1 computation
- Large file (multipart) upload with parallel part uploads, cancellation via `AbortSignal`
- Parallel ranged downloads with ordered chunk reassembly
- Sync engine: `synchronize()` async generator + `LocalFolder` / `B2Folder` scanners + compare/keep policies
- `B2Simulator` in-memory test server (no network required) — now supports `b2_list_parts`, `b2_copy_part`, `b2_update_file_retention`, `b2_update_file_legal_hold`, and monotonic upload timestamps for deterministic version ordering
- Full TypeScript types for all B2 API request/response types
- Branded ID types (`BucketId`, `FileId`, `KeyId`, etc.)
- `B2Error` hierarchy with 13 subclasses and automatic retry classification
- `RetryTransport` with exponential backoff, jitter, `Retry-After` support, automatic reauth, and injectable `sleepImpl` for tests
- `IncrementalSha1` with Node.js `crypto` and WebCrypto `subtle` backends
- `ContentSource` adapters: `BufferSource`, `BlobSource`, `StreamSource`
- Upload URL pool with checkout/checkin/evict pattern
- SSE-B2 and SSE-C encryption support in upload and download paths
- Object lock (file retention) and legal hold support
- Event notification rules (get/set)
- S3-compatible helpers: `createS3ClientConfig`, `presignGetObjectUrl`
- Subpath exports for tree-shaking: `/raw`, `/errors`, `/auth`, `/auth/file`, `/streams`, `/simulator`, `/sync`, `/s3`
- Dual ESM + CJS output via Vite library mode
- Biome for linting and formatting; ESLint with strict JSDoc/TSDoc rules for doc completeness
- TypeDoc for API documentation
- Vitest test suite with 486 tests across 20 files at ≥ 95% statement coverage. Tests run cleanly under both vitest (Node) and Bun's vitest-compat (no module-level mocking required)

[Unreleased]: https://github.com/backblaze-labs/b2-sdk-typescript/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/backblaze-labs/b2-sdk-typescript/releases/tag/v0.1.0
