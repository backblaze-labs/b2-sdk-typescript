# @backblaze/b2-sdk

[![CI](https://github.com/backblaze-labs/b2-typescript-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/backblaze-labs/b2-typescript-sdk/actions/workflows/ci.yml)
[![API Docs](https://github.com/backblaze-labs/b2-typescript-sdk/actions/workflows/docs.yml/badge.svg)](https://backblaze-labs.github.io/b2-typescript-sdk/)
[![npm](https://img.shields.io/npm/v/@backblaze/b2-sdk?color=cb3837)](https://www.npmjs.com/package/@backblaze/b2-sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

The official Backblaze B2 Cloud Storage SDK for TypeScript and JavaScript.

**Isomorphic.** Works in Node.js 22+, browsers, Bun, Deno, Cloudflare Workers, and Vercel Edge.

**Async-first.** Built on Web Streams, `AbortSignal`, and `crypto.subtle`. No callbacks, no legacy APIs.

**Fully typed.** Branded IDs, discriminated unions for encryption settings and errors, strict TypeScript with `exactOptionalPropertyTypes`.

**Zero runtime dependencies.** The core package has no `dependencies` in `package.json`.

## Install

```bash
npm install @backblaze/b2-sdk
# or
pnpm add @backblaze/b2-sdk
# or
yarn add @backblaze/b2-sdk
```

## Quick start

```ts
import { B2Client } from '@backblaze/b2-sdk'

const client = new B2Client({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
})

await client.authorize()

// Create a bucket
const bucket = await client.createBucket({
  bucketName: 'my-app-data',
  bucketType: 'allPrivate',
})

// Upload a file
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
// List all buckets
const buckets = await client.listBuckets()

// Get a bucket by name
const bucket = await client.getBucket('my-bucket')

// Update bucket settings
await bucket.update({
  bucketType: 'allPublic',
  lifecycleRules: [{ fileNamePrefix: 'logs/', daysFromUploadingToHiding: 30 }],
})

// Delete a bucket
await bucket.delete()
```

### Uploads

Small files (under the recommended part size, typically 100 MB) are uploaded in a single request. Larger files automatically use multipart upload with parallel part uploads.

```ts
import { BufferSource, BlobSource } from '@backblaze/b2-sdk'

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
// Each range is retried independently with exponential backoff so a single
// transient 503 does not kill the whole transfer.
const obj = bucket.file('big-dataset.parquet')
const stream = obj.createReadStream(fileId, totalSize, {
  concurrency: 4,
  rangeSize: 10 * 1024 * 1024,
  maxRetries: 5,
})
```

### File operations

```ts
// List files (paginated)
const listing = await bucket.listFileNames({ prefix: 'photos/', maxFileCount: 100 })

// Iterate all files (async generator, handles pagination)
for await (const file of bucket.listAllFiles({ prefix: 'logs/' })) {
  console.log(file.fileName, file.contentLength)
}

// Look up the latest visible version by name (returns null if missing or hidden)
const info = await bucket.getFileInfoByName('hello.txt')

// Hide a file (soft delete)
await bucket.hideFile('old-config.json')

// Restore visibility by removing the latest hide marker
await bucket.unhide('old-config.json')

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
const key = await client.createKey({
  capabilities: ['readFiles', 'writeFiles'],
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
import { B2InsufficientCapabilityError } from '@backblaze/b2-sdk/errors'

const { ok, missing } = client.hasCapabilities(['readFiles', 'writeFiles'])
if (!ok) {
  throw new B2InsufficientCapabilityError(
    ['readFiles', 'writeFiles'],
    [...missing], // available capabilities is on accountInfo if needed
    missing,
  )
}
```

### Server-side encryption

```ts
import { SSE_B2, sseCustomer } from '@backblaze/b2-sdk'
import { EncryptionKey } from '@backblaze/b2-sdk/streams'

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
await bucket.updateFileRetention('important.pdf', fileId, {
  mode: 'governance',
  retainUntilTimestamp: Date.now() + 365 * 24 * 60 * 60 * 1000,
})

// Shorten a governance-mode retention. Requires the bypassGovernance capability.
await bucket.updateFileRetention(
  'important.pdf',
  fileId,
  { mode: 'governance', retainUntilTimestamp: Date.now() + 24 * 60 * 60 * 1000 },
  { bypassGovernance: true },
)

await bucket.updateFileLegalHold('evidence.pdf', fileId, 'on')
```

### Event notifications

```ts
await bucket.setNotificationRules([
  {
    name: 'upload-notify',
    eventTypes: ['b2:ObjectCreated:*'],
    isEnabled: true,
    targetConfiguration: {
      targetType: 'webhook',
      url: 'https://my-app.com/webhooks/b2',
    },
  },
])
```

### Download authorization

```ts
// Generate a short-lived download authorization for sharing
const auth = await bucket.getDownloadAuthorization('photos/', 3600)
```

### Persistent authorization (Node)

`FileAccountInfo` persists the authorization response to a JSON file on disk so processes can restart without re-authorizing. It implements the `AccountInfo` interface and is a drop-in replacement for `InMemoryAccountInfo`. Upload URL pools remain in memory.

```ts
import { B2Client } from '@backblaze/b2-sdk'
import { FileAccountInfo } from '@backblaze/b2-sdk/auth/file'

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
import { B2Client, Bucket, B2Object } from '@backblaze/b2-sdk'

// Low-level 1:1 API bindings (all 37 B2 native endpoints)
import { RawClient } from '@backblaze/b2-sdk/raw'

// Error types for catch blocks
import {
  B2Error,
  ExpiredAuthTokenError,
  CapExceededError,
  B2InsufficientCapabilityError,
} from '@backblaze/b2-sdk/errors'

// Auth backends (in-memory default, file-backed for Node persistence)
import { InMemoryAccountInfo } from '@backblaze/b2-sdk/auth'
import { FileAccountInfo } from '@backblaze/b2-sdk/auth/file'

// Streaming utilities + SSE-C key wrapper
import {
  IncrementalSha1,
  BufferSource,
  BlobSource,
  EncryptionKey,
} from '@backblaze/b2-sdk/streams'

// Sync engine (local <-> B2)
import { synchronize, LocalFolder, B2Folder } from '@backblaze/b2-sdk/sync'

// S3-compatible helpers (requires @aws-sdk/client-s3 peer dependency)
import { createS3ClientConfig, presignGetObjectUrl } from '@backblaze/b2-sdk/s3'

// In-memory B2 server for tests (no network required)
import { B2Simulator } from '@backblaze/b2-sdk/simulator'
```

## Custom transport

The SDK uses a pluggable transport layer. The default `FetchTransport` uses the native `fetch` API. You can provide your own:

```ts
import type { HttpTransport, HttpRequest, HttpResponse } from '@backblaze/b2-sdk'

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
import { B2Client } from '@backblaze/b2-sdk'
import { B2Simulator } from '@backblaze/b2-sdk/simulator'
import { BufferSource } from '@backblaze/b2-sdk/streams'

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
      bucketType: 'allPrivate',
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
import {
  B2Error,
  CapExceededError,
  DuplicateBucketNameError,
  B2InsufficientCapabilityError,
} from '@backblaze/b2-sdk/errors'

try {
  await client.createBucket({ bucketName: 'test', bucketType: 'allPrivate' })
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

## Runtime support

| Runtime | Version | Status |
|---|---|---|
| Node.js | 22+ | Primary target. CI runs the full suite on Node 22 and 24. |
| Bun | latest | Tested in CI via `bun test src/`. |
| Deno | latest | Supported. |
| Browsers | Chromium, Firefox, WebKit (last 2 evergreen) | Tested in CI via Playwright. |
| Cloudflare Workers | - | Supported. |
| Vercel Edge | - | Supported. |

Requires: `fetch`, Web Streams, `crypto.subtle`, `AbortSignal`. Node < 22 is not supported (Node 20 reached EOL April 2026).

The browser test suite (`pnpm test:browser`) runs the same source against real Chromium, Firefox, and WebKit instances. Only Node-specific tests (filename pattern `*.node.test.ts`, covering `node:fs`, `node:os`, `node:util.inspect`) are skipped.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
