# @backblaze-labs/b2-sdk

[![CI](https://github.com/backblaze-labs/b2-sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/backblaze-labs/b2-sdk-typescript/actions/workflows/ci.yml)
[![API Docs](https://github.com/backblaze-labs/b2-sdk-typescript/actions/workflows/docs.yml/badge.svg)](https://backblaze-labs.github.io/b2-sdk-typescript/)
[![npm](https://img.shields.io/npm/v/@backblaze-labs/b2-sdk?color=cb3837)](https://www.npmjs.com/package/@backblaze-labs/b2-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

A Backblaze-maintained TypeScript and JavaScript SDK for Backblaze B2 Cloud Storage, currently incubating in [Backblaze Labs](https://github.com/backblaze-labs).

**Isomorphic at the source level.** One source tree runs unmodified in Node.js 22+, Bun, Deno, browsers, Cloudflare Workers, and Vercel Edge. Internal imports use `.ts` extensions so Deno reads `src/` directly with no build step. See [Source isomorphism](#source-isomorphism).

**Async-first.** Built on Web Streams, `AbortSignal`, and `crypto.subtle`. No callbacks, no legacy APIs.

**Fully typed.** Branded IDs, discriminated unions for encryption settings and errors, strict TypeScript with `exactOptionalPropertyTypes`.

**Zero runtime dependencies.** The core package has no `dependencies` in `package.json`.

**Full API reference:** [backblaze-labs.github.io/b2-sdk-typescript](https://backblaze-labs.github.io/b2-sdk-typescript/) (generated from source on every push to `main`).

## Install

```bash
npm install @backblaze-labs/b2-sdk
# or
pnpm add @backblaze-labs/b2-sdk
# or
yarn add @backblaze-labs/b2-sdk
```

## Quick start

```ts
import { B2Client, BufferSource } from '@backblaze-labs/b2-sdk'

const client = new B2Client({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
})

await client.authorize()

const bucket = await client.getBucket('my-app-data')
if (!bucket) throw new Error('bucket not found')

const data = new TextEncoder().encode('Hello, B2!')
const file = await bucket.upload({
  fileName: 'hello.txt',
  source: new BufferSource(data),
  contentType: 'text/plain',
})

console.log(`Uploaded: ${file.fileName} (${file.contentLength} bytes)`)
```

## Features

### Buckets

```ts
import { BucketType } from '@backblaze-labs/b2-sdk'

// List all buckets
const buckets = await client.listBuckets()

// Get a bucket by name
const bucket = await client.getBucket('my-bucket')

// Update bucket settings
await bucket.update({
  bucketType: BucketType.AllPublic,
  lifecycleRules: [{ fileNamePrefix: 'logs/', daysFromUploadingToHiding: 30 }],
})

// Delete a bucket
await bucket.delete()
```

> The `BucketType`, `RetentionMode`, `LegalHoldValue`, `Capability`, `EventType`, and `EncryptionMode` `as const` objects exported from the main entry give you type-safe alternatives to the raw string literals — pick whichever style you prefer; both are accepted at the type level.

### Uploads

Small files (under the recommended part size, typically 100 MB) are uploaded in a single request. Larger files automatically use multipart upload with parallel part uploads.

```ts
import { BufferSource, BlobSource } from '@backblaze-labs/b2-sdk'

// From a Uint8Array
await bucket.upload({
  fileName: 'data.bin',
  source: new BufferSource(myUint8Array),
})

// From a Blob or File (browser)
await bucket.upload({
  fileName: 'photo.jpg',
  source: new BlobSource(fileInput.files[0]),
  contentType: 'image/jpeg',
})

// Large file with progress tracking
await bucket.upload({
  fileName: 'backup.tar.gz',
  source: new BlobSource(largeBlob),
  concurrency: 8,
  partSize: 64 * 1024 * 1024,
  onProgress: (event) => {
    console.log(`${event.bytesTransferred}/${event.totalBytes} bytes`)
  },
  signal: AbortSignal.timeout(300_000),
})
```

Transient upload failures are retried with a fresh B2 upload URL, matching B2's documented flow. If the first upload POST succeeded but its response was lost, retrying can create a duplicate file version.

Use `onUploadRetry` to log or count retry attempts, compare returned file IDs and SHA-1 values when reconciling uploads, and configure lifecycle or version-retention rules for buckets where duplicate versions must be cleaned up automatically. Payload re-POSTs and fresh-URL fetches spend one upload retry budget and are bounded by `retry.maxRetries + 1` attempts per file or part; aggregate retries scale with multipart transfer concurrency. Set `retryResponseBodyFailures: false` to fail instead of re-sending a payload when the success response body is lost. The SDK does not impose a default upload request timeout; pass `AbortSignal.timeout(...)` or your own abort signal when a hung connection needs a deadline.

#### Resume a failed multipart upload

Pass `resume: true` and the SDK looks up the matching unfinished large file via `b2_list_unfinished_large_files`, checks which parts are already on the server, and only re-uploads the missing ones. Parts whose locally-recomputed SHA-1 matches the server's are skipped.

```ts
// Restart the upload that crashed at part 47 of 100
await bucket.upload({
  fileName: 'backup.tar.gz',
  source: new BlobSource(largeBlob),
  partSize: 64 * 1024 * 1024,
  resume: true,
})

// Or target a specific in-progress large file explicitly
await bucket.upload({
  fileName: 'backup.tar.gz',
  source: new BlobSource(largeBlob),
  resumeFileId: knownLargeFileId,
})
```

#### Streaming uploads via WritableStream

Pipe any `ReadableStream<Uint8Array>` straight into B2. The SDK buffers up to `partSize` bytes per part and uploads them in parallel through the multipart protocol. Backpressure is honoured via the internal queue.

```ts
const { writable, done } = bucket.file('logs.ndjson').createWriteStream({
  partSize: 16 * 1024 * 1024,
  concurrency: 4,
})

// Pipe from any ReadableStream source: fetch().body, fs.createReadStream(...) (with toWeb), etc.
await response.body.pipeTo(writable)
const fileVersion = await done
console.log(`Streamed upload finished: ${fileVersion.fileName} (${fileVersion.contentLength} bytes)`)
```

> Streaming uploads do not support resume because the total size and per-part SHA-1s are not known in advance. Use the buffered `upload` path with `resume: true` when that matters.

### Downloads

```ts
// Download by file name
const result = await bucket.download('hello.txt')
const text = await new Response(result.body).text()

// Download by file ID with range
const partial = await bucket.download('large-file.bin', {
  range: 'bytes=0-1023',
})

// Parallel ranged download (for large files).
// Each range uses the client's configured RetryTransport budget, so transient
// 503s are retried without adding a second default retry layer per chunk.
const obj = bucket.file('big-dataset.parquet')
const stream = obj.createReadStream(fileId, totalSize, {
  concurrency: 4,
  rangeSize: 10 * 1024 * 1024,
})
```

Full-body downloads are automatically verified when B2 returns a real `X-Bz-Content-Sha1` digest. If the downloaded bytes do not match, the body stream errors with `ChecksumMismatchError`; discard any partially written output when piping to disk. HEAD requests, range GETs, and files whose SHA-1 is unavailable are not verified because no matching whole-body digest exists.

### File operations

```ts
// List files (single page)
const listing = await bucket.listFileNames({ prefix: 'photos/', pageSize: 100 })

// Iterate all files (async generator, handles pagination)
for await (const file of bucket.paginateFileNames({ prefix: 'logs/' })) {
  console.log(file.fileName, file.contentLength)
}

// Look up the latest visible version by name (returns null if missing or hidden)
const info = await bucket.getFileInfoByName('hello.txt')

// Fetch metadata without transferring the body (HTTP HEAD). Returns a
// body-less result so callers never have to drain a (logically empty)
// HEAD response stream themselves.
const { headers } = await bucket.head('hello.txt')
console.log(headers.contentLength, headers.contentSha1)

// Hide a file (soft delete)
await bucket.hideFile('old-config.json')

// Restore visibility by removing the latest hide marker
await bucket.unhideFile('old-config.json')

// Delete a specific file version
await bucket.deleteFileVersion('file.txt', fileId)

// Server-side copy (single call, suitable for any size B2 supports)
await bucket.copyFile({
  sourceFileId: originalFileId,
  fileName: 'copy-of-file.txt',
})

// Server-side multipart copy for large files. Splits the source into parts
// copied in parallel via b2_copy_part. Falls back to copyFile below partSize.
await bucket.copyLargeFile({
  sourceFileId: originalFileId,
  fileName: 'big-replica.bin',
  partSize: 64 * 1024 * 1024,
  concurrency: 4,
})
```

### Bulk delete

Two primitives on `Bucket` for cleanup at scale:

```ts
// Delete a known set of file versions with bounded concurrency
const result = await bucket.deleteMany(
  [
    { fileName: 'a.txt', fileId: id1 },
    { fileName: 'b.txt', fileId: id2 },
  ],
  { concurrency: 10 },
)
console.log(`deleted=${result.deleted} errors=${result.errors.length}`)

// Stream-delete every version matching a prefix (or the whole bucket if omitted).
// Yields a DeleteAllEvent per version; never materialises the full list in memory.
for await (const event of bucket.deleteAll({ prefix: 'tmp/', dryRun: false })) {
  if (event.type === 'delete') console.log('deleted', event.fileName)
  else if (event.type === 'error') console.warn('failed', event.fileName, event.message)
}
```

### Application keys

```ts
import { Capability } from '@backblaze-labs/b2-sdk'

const key = await client.createKey({
  capabilities: [Capability.ReadFiles, Capability.WriteFiles],
  keyName: 'my-app-key',
  bucketId: bucket.id,
  namePrefix: 'uploads/',
  validDurationInSeconds: 86400,
})

const keys = await client.listKeys()
await client.deleteKey(key.applicationKeyId)
```

#### Capability checks

Fail fast with a typed error instead of waiting for a server 401/403:

```ts
import { Capability } from '@backblaze-labs/b2-sdk'
import { B2InsufficientCapabilityError } from '@backblaze-labs/b2-sdk/errors'

const required = [Capability.ReadFiles, Capability.WriteFiles]
const { ok, missing } = client.hasCapabilities(required)
if (!ok) {
  throw new B2InsufficientCapabilityError(required, [...missing], missing)
}
```

### Server-side encryption

```ts
import { SSE_B2, sseCustomer } from '@backblaze-labs/b2-sdk'
import { EncryptionKey } from '@backblaze-labs/b2-sdk/streams'

// SSE-B2 (Backblaze-managed keys)
await bucket.upload({
  fileName: 'encrypted.dat',
  source: new BufferSource(data),
  serverSideEncryption: SSE_B2,
})

// SSE-C (customer-provided keys) - precomputed digests
await bucket.upload({
  fileName: 'secret.dat',
  source: new BufferSource(data),
  serverSideEncryption: sseCustomer(base64Key, base64KeyMd5),
})

// SSE-C from raw bytes (Node). EncryptionKey computes the MD5 internally and
// redacts itself in JSON.stringify, toString, and Node's util.inspect so the
// key never lands in logs.
const key = await EncryptionKey.fromBytes(randomBytes(32))
await bucket.upload({
  fileName: 'secret.dat',
  source: new BufferSource(data),
  serverSideEncryption: key,
})
console.log(key)            // [EncryptionKey SSE-C [redacted SSE-C key]]
JSON.stringify(key)         // customer key and MD5 fields show "[redacted SSE-C key]"
```

### Object lock and legal hold

```ts
import { LegalHoldValue, RetentionMode } from '@backblaze-labs/b2-sdk'

await bucket.updateFileRetention('important.pdf', fileId, {
  mode: RetentionMode.Governance,
  retainUntilTimestamp: Date.now() + 365 * 24 * 60 * 60 * 1000,
})

// Shorten a governance-mode retention. Requires the bypassGovernance capability.
await bucket.updateFileRetention(
  'important.pdf',
  fileId,
  { mode: RetentionMode.Governance, retainUntilTimestamp: Date.now() + 24 * 60 * 60 * 1000 },
  { bypassGovernance: true },
)

await bucket.updateFileLegalHold('evidence.pdf', fileId, LegalHoldValue.On)
```

### Event notifications

```ts
import { EventType } from '@backblaze-labs/b2-sdk'

await bucket.setNotificationRules([
  {
    name: 'upload-notify',
    eventTypes: [EventType.ObjectCreatedAll],
    isEnabled: true,
    targetConfiguration: {
      targetType: 'webhook',
      url: 'https://my-app.com/webhooks/b2',
      hmacSha256SigningSecret: process.env.B2_WEBHOOK_SECRET,
    },
  },
])
```

On the receiving side, verify the `X-Bz-Event-Notification-Signature` header before trusting the payload. The `@backblaze-labs/b2-sdk/notifications` subpath ships HMAC-SHA256 helpers so you don't have to implement constant-time signature checking yourself:

```ts
import {
  B2_WEBHOOK_SIGNATURE_HEADER,
  requireValidWebhook,
} from '@backblaze-labs/b2-sdk/notifications'

// Inside your HTTP handler. `body` must be the raw request bytes — any
// JSON re-serialisation will invalidate the HMAC.
const body = new Uint8Array(await request.arrayBuffer())
const payload = await requireValidWebhook({
  body,
  signature: request.headers.get(B2_WEBHOOK_SIGNATURE_HEADER),
  secret: process.env.B2_WEBHOOK_SECRET,
})
for (const event of payload.events) {
  console.log(event.eventType, event.objectName)
}
```

`requireValidWebhook` throws on missing/invalid signature and returns the parsed payload on success. If you'd rather branch on a boolean (e.g. to log the failure reason without throwing), use the lower-level `verifyWebhookSignature` which returns `{ valid, reason, payload }`.

### Download authorization

```ts
// Generate a short-lived download authorization for sharing
const auth = await bucket.getDownloadAuthorization('photos/', 3600)
```

### Persistent authorization (Node)

`FileAccountInfo` persists the authorization response to a JSON file on disk so processes can restart without re-authorizing. It implements the `AccountInfo` interface and is a drop-in replacement for `InMemoryAccountInfo`. Upload URL pools remain in memory.

```ts
import { B2Client } from '@backblaze-labs/b2-sdk'
import { FileAccountInfo } from '@backblaze-labs/b2-sdk/auth/file'

const accountInfo = new FileAccountInfo('/var/cache/my-app/b2-auth.json')
await accountInfo.load() // populate from disk if the file exists

const client = new B2Client({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
  accountInfo,
})

if (accountInfo.getAuth() === null) {
  await client.authorize() // first run, or token cleared
}
```

`load()` returns silently on missing or corrupt files (a fresh `authorize()` will populate fresh state). Call `await accountInfo.flushed()` before process exit if you need to guarantee the latest state has hit disk.

## Subpath exports

The SDK is organized into subpath exports for tree-shaking:

```ts
// High-level facade (most users need only this)
import { B2Client, Bucket, B2Object } from '@backblaze-labs/b2-sdk'

// Low-level 1:1 API bindings for the B2 native endpoints the SDK uses
import { RawClient } from '@backblaze-labs/b2-sdk/raw'

// Error types for catch blocks
import {
  B2Error,
  ExpiredAuthTokenError,
  CapExceededError,
  B2InsufficientCapabilityError,
} from '@backblaze-labs/b2-sdk/errors'

// Auth backends (in-memory default, file-backed for Node persistence)
import { InMemoryAccountInfo } from '@backblaze-labs/b2-sdk/auth'
import { FileAccountInfo } from '@backblaze-labs/b2-sdk/auth/file'

// Streaming utilities + SSE-C key wrapper
import {
  IncrementalSha1,
  BufferSource,
  BlobSource,
  EncryptionKey,
} from '@backblaze-labs/b2-sdk/streams'

// Sync engine (local <-> B2)
import { synchronize, LocalFolder, B2Folder } from '@backblaze-labs/b2-sdk/sync'

// S3-compatible helpers (requires @aws-sdk/client-s3 peer dependency)
import { createS3ClientConfig, presignGetObjectUrl } from '@backblaze-labs/b2-sdk/s3'

// In-memory B2 server for tests (no network required)
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
```

Every export is documented with full type signatures in the [API reference](https://backblaze-labs.github.io/b2-sdk-typescript/).

## Custom transport

The SDK uses a pluggable transport layer. The default `FetchTransport` uses the native `fetch` API. You can provide your own:

```ts
import type { HttpTransport, HttpRequest, HttpResponse } from '@backblaze-labs/b2-sdk'

class MyTransport implements HttpTransport {
  async send(request: HttpRequest): Promise<HttpResponse> {
    // your implementation
  }
}

const client = new B2Client({
  applicationKeyId: '...',
  applicationKey: '...',
  transport: new MyTransport(),
})
```

## Identifying your traffic (User-Agent)

Every request the SDK issues carries a User-Agent header that Backblaze can grep server logs by:

```
b2-sdk-typescript/0.1.0 (typescript; @backblaze-labs/b2-sdk; node/24.14.1; linux; x64)
```

Both `b2-sdk-typescript/` (stable product token) and `@backblaze-labs/b2-sdk` (npm package name) are part of the documented contract — log queries that match either one find every request issued by this SDK. The comment block also reports the runtime (`node/<version>`, `bun/<version>`, `deno/<version>`, or `browser`) plus the OS and architecture on non-browser runtimes.

The version is read straight from `package.json` via a JSON import attribute, so bumping the package version automatically propagates to the UA, the published artifact, and the runtime constant. There is no second source of truth to keep in sync.

To prepend your own application identifier:

```ts
const client = new B2Client({
  applicationKeyId,
  applicationKey,
  userAgent: 'my-app/1.0',
})
// → "my-app/1.0 b2-sdk-typescript/0.1.0 (typescript; @backblaze-labs/b2-sdk; node/24.14.1; linux; x64)"
```

## SSRF guard

The default `FetchTransport` ships an allow-list guard that rejects any URL whose host falls outside the authorized B2 realm. This defends against URL-substitution attacks where a compromised or hostile B2 endpoint could return an upload URL pointing at an internal service (e.g. cloud metadata at `169.254.169.254`) and trick the SDK into making an authenticated request to it.

```ts
const client = new B2Client({ applicationKeyId, applicationKey })
await client.authorize()
// Guard is now locked. Hosts under backblazeb2.com / backblaze.com are
// allowed; literal IPs, localhost, metadata.google.internal, *.internal,
// and *.local are rejected unconditionally; anything else throws B2SsrfError.

client.urlGuard?.getAllowedSuffixes()
// => ['backblaze.com', 'backblazeb2.com']
```

You can extend the allow-list (e.g. for a self-hosted MITM proxy during debugging) without disabling the guard:

```ts
new B2Client({
  applicationKeyId,
  applicationKey,
  allowedHostSuffixes: ['internal-proxy.example'],
})
```

Passing `allowedHostSuffixes: []` disables the guard entirely and should be reserved for trusted tests or controlled local harnesses. For custom realms, the SDK uses the hosts returned by `b2_authorize_account` as scoped suffixes, allowing those hosts and their subdomains without broadening unknown domains to public suffixes such as `co.uk`.

Passing a custom `transport` opts out of the guard (your transport, your threat model).

## Retry behavior

The SDK automatically retries transient errors with exponential backoff:

- **401 expired_auth_token**: re-authorizes and retries
- **503, 408, 429**: exponential backoff with jitter, respects `Retry-After` header
- **Network errors**: retried with backoff
- **Permanent errors** (403 cap_exceeded, 404 not_found, etc.): thrown immediately

Configure retry behavior:

```ts
const client = new B2Client({
  applicationKeyId: '...',
  applicationKey: '...',
  retry: {
    maxRetries: 10,
    maxRetryDelayMs: 120_000,
    initialRetryDelayMs: 500,
  },
})
```

## Testing with the simulator

The SDK ships an in-memory B2 simulator for unit testing without network access:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { B2Client, BucketType } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { BufferSource } from '@backblaze-labs/b2-sdk/streams'

describe('my app', () => {
  let client: B2Client

  beforeEach(async () => {
    const sim = new B2Simulator()
    client = new B2Client({
      applicationKeyId: 'test',
      applicationKey: 'test',
      transport: sim.transport(),
    })
    await client.authorize()
  })

  it('uploads and retrieves a file', async () => {
    const bucket = await client.createBucket({
      bucketName: 'test-bucket',
      bucketType: BucketType.AllPrivate,
    })

    await bucket.upload({
      fileName: 'test.txt',
      source: new BufferSource(new TextEncoder().encode('hello')),
    })

    const listing = await bucket.listFileNames()
    expect(listing.files).toHaveLength(1)
    expect(listing.files[0].fileName).toBe('test.txt')
  })
})
```

## Error handling

All B2 API errors are thrown as typed `B2Error` subclasses (13 in total). Client-side capability checks throw `B2InsufficientCapabilityError`.

```ts
import { BucketType } from '@backblaze-labs/b2-sdk'
import {
  B2Error,
  CapExceededError,
  DuplicateBucketNameError,
  B2InsufficientCapabilityError,
} from '@backblaze-labs/b2-sdk/errors'

try {
  await client.createBucket({ bucketName: 'test', bucketType: BucketType.AllPrivate })
} catch (err) {
  if (err instanceof DuplicateBucketNameError) {
    console.log('Bucket already exists')
  } else if (err instanceof CapExceededError) {
    console.log('Storage cap exceeded, upgrade your plan')
  } else if (err instanceof B2InsufficientCapabilityError) {
    console.log('Missing capabilities:', err.missing)
  } else if (err instanceof B2Error) {
    console.log(`B2 error: ${err.code} (status ${err.status}, retryable: ${err.retryable})`)
  }
}
```

## B2-native primitives, with an S3 escape hatch

The high-level surface (`B2Client`, `Bucket`, `B2Object`) gives you direct access to features that live in B2's native API:

- **Per-part and whole-file SHA-1 verification** on multipart uploads, plus automatic whole-file verification on downloads when B2 provides a digest.
- **`b2_copy_part` server-side multipart copy** via `bucket.copyLargeFile()` — no client-side bytes touched.
- **File retention + legal hold** (object lock) on `bucket.updateFileRetention()` and `bucket.updateFileLegalHold()`.
- **Time-scoped download tokens** via `bucket.getDownloadAuthorization()` for sharing without exposing the application key.
- **Replication configuration** via `bucket.update({ replicationConfiguration })`.
- **Event notification rules** via `bucket.getNotificationRules()` and `bucket.setNotificationRules()`.
- **Application key restrictions** (per-bucket, per-prefix, per-capability) via `client.createKey()`.

When you want S3 compatibility instead — for tooling that already speaks S3, or for the Bandwidth Alliance proxy pattern — `@backblaze-labs/b2-sdk/s3` exposes `createS3ClientConfig()` and `presignGetObjectUrl()` so the same SDK covers both surfaces.

## Source isomorphism

The SDK is isomorphic at the **source** level, not just at the built artifact level. Every internal import uses a `.ts` extension (`import { foo } from './foo.ts'`, not `'./foo.js'`), `tsconfig.json` has `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`, and Vite rewrites the extensions to `.js` during build so npm consumers still see a normal `dist/`.

What this means in practice: you can point a runtime straight at `src/` without a build step.

```bash
# Deno reads src/ directly. No `pnpm build`, no node_modules, no npm: shim.
deno check examples/node-list-buckets.ts

# Bun does the same.
bun examples/node-list-buckets.ts

# Node 22.6+ with --experimental-strip-types runs raw .ts.
node --experimental-strip-types examples/node-list-buckets.ts
```

So you get both: an `npm install`-ready `dist/` (ESM + CJS + DTS), *and* a `src/` tree that runs in Node, Bun, and Deno without a build. Useful when extending the SDK locally, contributing PRs, or vendoring the source into a Deno project.

## Runtime support

| Runtime | Version | Status |
|---|---|---|
| Node.js | 22+ | Primary target. CI runs the full suite on Node 22 and 24 across Linux, Windows, and macOS. |
| Bun | latest | Tested in CI via `bun test src/` + example typecheck. |
| Deno | 2.x | Source isomorphism verified in CI via `deno check` against `src/`. |
| Browsers | Chromium, Firefox, WebKit (last 2 evergreen) | Tested in CI via Playwright. |
| Cloudflare Workers | - | Supported. |
| Vercel Edge | - | Supported. |

Requires: `fetch`, Web Streams, `crypto.subtle`, `AbortSignal`. Node < 22 is not supported (Node 20 reached EOL April 2026).

The browser test suite (`pnpm test:browser`) runs the same source against real Chromium, Firefox, and WebKit instances. Only Node-specific tests (filename pattern `*.node.test.ts`, covering `node:fs`, `node:os`, `node:util.inspect`) are skipped.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
