# PR 97 review map

This PR intentionally spans several contracts that were developed together but
can be reviewed as separate maintenance areas. Use this map to audit behavior,
exports, and tests by subsystem.

## File and stream sources

- Public API: `FileSource`, `FileSource.fromPath`, `toContentSource`, stream
  source handling, `ContentSource.canSlice`, and source byte-count validation.
- Behavior: Node file reads are lazy, ranged, sliceable, identity-checked, and
  safe against path replacement. Forward-only streams validate exact byte counts
  and bound empty chunks.
- Tests: `src/streams/source.node.test.ts`, `src/streams/streams.test.ts`,
  `src/upload/upload-coverage.test.ts`, and browser import coverage.

## Upload retries and cleanup diagnostics

- Public API: `UploadRetryOptions`, `onUploadRetry`,
  `retryResponseBodyFailures`, `CleanupFailureEvent`,
  `CleanupFailureListener`, and `FinishLargeFileResponseBodyError` metadata.
- Behavior: single uploads, multipart uploads, streaming uploads, and
  multipart copies can fetch fresh upload URLs on retryable failures. Ambiguous
  finish failures are reported with `fileId`, `bucketId`, and `fileName`, skip
  cancellation, and emit `reason: "finish-ambiguous"`.
- Tests: `src/upload/upload-coverage.test.ts`,
  `src/upload/stream-coverage.test.ts`, `src/copy/copy.test.ts`, and
  `src/copy/copy.slow.test.ts`.

## Auth, transport, and URL safety

- Public API: realm URL handling, auth-cache behavior,
  `followSameOriginRedirects`, URL redaction, and `B2Client.getBucket(name)`.
- Behavior: custom realm cache reuse is host-bound, same-origin redirect checks
  are explicit, SSRF guards reject unsafe URLs, and bucket-name lookup falls
  back to unfiltered listing when required.
- Tests: `src/auth/auth.test.ts`, `src/auth/file.node.test.ts`,
  `src/http/transport.test.ts`, `src/http/url-guard.test.ts`, and
  `src/client.test.ts`.

## Sync path handling

- Public API: sync scanners and local-to-B2 / B2-to-local sync behavior.
- Behavior: local uploads stream through `FileSource.fromPath`, production
  downloads validate destination paths through the shared path-safety layer, and
  SDK-owned temp files use a reserved namespace rejected by local and B2 scans.
- Tests: `src/sync/paths.test.ts`, `src/sync/path-safety.test.ts`,
  `src/sync/local-file-io.node.test.ts`,
  `src/sync/scanners/scanners.node.test.ts`, and
  `src/sync/synchronizer.test.ts`.

## Release workflow hardening

- Public surface: repository release automation and `verify:release-workflow`.
- Behavior: build and metadata generation run without OIDC privileges; the
  publishing job receives data-only artifacts, does not checkout the release
  ref, and does not execute repository scripts while `id-token: write` is
  available.
- Tests: `pnpm run verify:release-workflow`.

## Documentation and generated metadata

- Public surface: README, changelog, `llms.txt`, TypeDoc output, export
  metadata, and runtime support notes.
- Behavior: docs describe the new source, retry, cleanup, sync, and release
  contracts without changing runtime behavior.
- Tests: `pnpm lint:docs`, `pnpm lint:spelling`, `pnpm run docs`,
  `pnpm run verify:exports`, and `pnpm run verify:metadata`.
