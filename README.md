# @backblaze/b2-sdk

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

### Downloads

```ts
// Download by file name
const result = await bucket.download('hello.txt')
const text = await new Response(result.body).text()

// Download by file ID with range
const partial = await bucket.download('large-file.bin', {
  range: 'bytes=0-1023',
})

// Parallel ranged download (for large files)
const obj = bucket.file('big-dataset.parquet')
const stream = obj.createReadStream(fileId, totalSize, {
  concurrency: 4,
  rangeSize: 10 * 1024 * 1024,
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

// Hide a file (soft delete)
await bucket.hideFile('old-config.json')

// Delete a specific file version
await bucket.deleteFileVersion('file.txt', fileId)

// Server-side copy
await bucket.copyFile({
  sourceFileId: originalFileId,
  fileName: 'copy-of-file.txt',
})
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

### Server-side encryption

```ts
import { SSE_B2, sseCustomer } from '@backblaze/b2-sdk'

// SSE-B2 (Backblaze-managed keys)
await bucket.upload({
  fileName: 'encrypted.dat',
  source: new BufferSource(data),
  serverSideEncryption: SSE_B2,
})

// SSE-C (customer-provided keys)
await bucket.upload({
  fileName: 'secret.dat',
  source: new BufferSource(data),
  serverSideEncryption: sseCustomer(base64Key, base64KeyMd5),
})
```

### Object lock and legal hold

```ts
await bucket.updateFileRetention('important.pdf', fileId, {
  mode: 'governance',
  retainUntilTimestamp: Date.now() + 365 * 24 * 60 * 60 * 1000,
})

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

## Subpath exports

The SDK is organized into subpath exports for tree-shaking:

```ts
// High-level facade (most users need only this)
import { B2Client, Bucket, B2Object } from '@backblaze/b2-sdk'

// Low-level 1:1 API bindings (all 37 B2 native endpoints)
import { RawClient } from '@backblaze/b2-sdk/raw'

// Error types for catch blocks
import { B2Error, ExpiredAuthTokenError, CapExceededError } from '@backblaze/b2-sdk/errors'

// Auth backends
import { InMemoryAccountInfo } from '@backblaze/b2-sdk/auth'

// Streaming utilities
import { IncrementalSha1, BufferSource, BlobSource } from '@backblaze/b2-sdk/streams'

// In-memory B2 server for tests (no network required)
import { B2Simulator } from '@backblaze/b2-sdk/simulator'

// S3-compatible wrapper (requires @aws-sdk/client-s3 peer dependency)
import {} from '@backblaze/b2-sdk/s3' // coming soon

// Sync engine (local <-> B2)
import {} from '@backblaze/b2-sdk/sync' // coming soon
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

All B2 API errors are thrown as typed `B2Error` subclasses:

```ts
import { B2Error, CapExceededError, DuplicateBucketNameError } from '@backblaze/b2-sdk/errors'

try {
  await client.createBucket({ bucketName: 'test', bucketType: 'allPrivate' })
} catch (err) {
  if (err instanceof DuplicateBucketNameError) {
    console.log('Bucket already exists')
  } else if (err instanceof CapExceededError) {
    console.log('Storage cap exceeded, upgrade your plan')
  } else if (err instanceof B2Error) {
    console.log(`B2 error: ${err.code} (status ${err.status}, retryable: ${err.retryable})`)
  }
}
```

## Runtime support

| Runtime | Version | Status |
|---|---|---|
| Node.js | 22+ | Primary target |
| Bun | latest | Supported |
| Deno | latest | Supported |
| Browsers | last 2 evergreen | Supported |
| Cloudflare Workers | - | Supported |
| Vercel Edge | - | Supported |

Requires: `fetch`, Web Streams, `crypto.subtle`, `AbortSignal`. Node < 22 is not supported (Node 20 reached EOL April 2026).

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.
