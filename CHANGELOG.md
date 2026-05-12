# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `B2Client` high-level facade with bucket and key management
- `Bucket` handle: upload, download, list, hide, delete, copy, update, notifications, retention, legal hold
- `B2Object` handle: upload, download, parallel download stream, file info, hide, delete
- `RawClient` with all 37 B2 native API endpoint bindings
- Single-file upload with automatic SHA-1 computation
- Large file (multipart) upload with parallel part uploads, cancellation via `AbortSignal`
- Parallel ranged downloads with ordered chunk reassembly
- `B2Simulator` in-memory test server (no network required)
- Full TypeScript types for all B2 API request/response types
- Branded ID types (`BucketId`, `FileId`, `KeyId`, etc.)
- `B2Error` hierarchy with 12 subclasses and automatic retry classification
- `RetryTransport` with exponential backoff, jitter, `Retry-After` support, and automatic reauth
- `IncrementalSha1` with Node.js `crypto` and WebCrypto `subtle` backends
- `ContentSource` adapters: `BufferSource`, `BlobSource`, `StreamSource`
- Upload URL pool with checkout/checkin/evict pattern
- SSE-B2 and SSE-C encryption support in upload and download paths
- Object lock (file retention) and legal hold support
- Event notification rules (get/set)
- Subpath exports for tree-shaking: `/raw`, `/errors`, `/auth`, `/streams`, `/simulator`, `/sync`, `/s3`
- Dual ESM + CJS output via Vite library mode
- Biome for linting and formatting
- Vitest test suite with 15 tests against B2Simulator
