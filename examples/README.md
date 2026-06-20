# Examples

Runnable examples demonstrating `@backblaze-labs/b2-sdk` usage patterns.

## Contents

- [Prerequisites](#prerequisites)
- **Node.js examples**
  - [List buckets](#list-buckets) (`node-list-buckets.ts`)
  - [Upload a file](#upload-a-file) (`node-upload.ts`)
  - [Download a file](#download-a-file) (`node-download.ts`)
  - [Sync a directory](#sync-a-directory) (`node-sync-cli.ts`)
  - [Upload with a progress bar](#upload-with-a-progress-bar) (`node-with-progress.ts`)
- **Browser**
  - [Browser uploader](#browser-uploader) (`browser-uploader/`)
- **Cookbook** (production-shaped recipes)
  - [Presigned URLs with auth (downloads)](#presigned-urls-with-auth-downloads) (`node-presigned-with-auth/`)
  - [React Native uploads via presigned URLs](#react-native-uploads-via-presigned-urls) (`react-native-presigned/`)
  - [Cloudflare Workers + Bandwidth Alliance](#cloudflare-workers--bandwidth-alliance) (`cloudflare-bandwidth-alliance/`)
  - [Encrypted backup CLI](#encrypted-backup-cli) (`node-backup-cli/`)
  - [Plugin template for host frameworks](#plugin-template-for-host-frameworks) (`node-plugin-template/`)

## Prerequisites

All examples require B2 credentials via environment variables:

```bash
export B2_APPLICATION_KEY_ID=your-key-id
export B2_APPLICATION_KEY=your-application-key
```

Run from the SDK root directory. Examples use `npx tsx` for direct TypeScript execution, but thanks to the SDK's [source-level isomorphism](../README.md#source-isomorphism), the `node-*` scripts also run unchanged in Bun and Deno:

```bash
# Node 22+ (with tsx)
npx tsx examples/node-list-buckets.ts

# Bun
bun examples/node-list-buckets.ts

# Deno (no build, no node_modules)
deno run --allow-net --allow-env --config examples/deno.json examples/node-list-buckets.ts
```

CI proves all three runtimes typecheck the example sources directly against `../src/` — see [`.github/workflows/examples.yml`](../.github/workflows/examples.yml).

## Node.js examples

### List buckets

List all buckets in your B2 account.

```bash
npx tsx examples/node-list-buckets.ts
```

### Upload a file

Upload a local file to a B2 bucket.

```bash
npx tsx examples/node-upload.ts my-bucket ./photo.jpg
```

### Download a file

Download a file from B2 to the local filesystem.

```bash
npx tsx examples/node-download.ts my-bucket photo.jpg [output-path]
```

### Sync a directory

Sync a local directory to a B2 bucket prefix. Supports modtime/size/SHA-1 comparison, delete mode, dry-run, and configurable concurrency.

```bash
npx tsx examples/node-sync-cli.ts ./local-dir my-bucket backup/

# With options
SYNC_MODE=size SYNC_DELETE=true SYNC_CONCURRENCY=8 SYNC_DRY_RUN=true \
  npx tsx examples/node-sync-cli.ts ./local-dir my-bucket backup/
```

| Env var | Default | Description |
|---------|---------|-------------|
| `SYNC_MODE` | `modtime` | Compare mode: `modtime`, `size`, `sha1`, or `none` |
| `SYNC_DELETE` | `false` | Delete remote files not present locally |
| `SYNC_CONCURRENCY` | `4` | Parallel upload/download workers |
| `SYNC_DRY_RUN` | `false` | Print actions without executing them |

`SYNC_MODE=sha1` hashes local files and compares them with B2 SHA-1 metadata. B2's verified
single-part `contentSha1` can prove equality; multipart `fileInfo.large_file_sha1` and
`unverified:<hex>` values are treated as untrusted hints and verified by reading the selected B2
version's bytes. It is useful for accidental drift detection, not as a cryptographic tamper
guarantee. Files without any comparable remote SHA-1 are skipped with a surfaced event instead of
being transferred repeatedly.

SHA-1 comparison reads matching-size local files in full before transfers are executed. Untrusted
B2 metadata also causes a selected-version download so the SDK can hash real B2 bytes before
treating the pair as equal. `SYNC_CONCURRENCY` bounds SHA-1 comparison workers, transfer workers,
and queued transfer promises, but hashing and transfer do not fully overlap. Changed uploads may
read the same file again for transfer. `SYNC_DRY_RUN=true` still performs those comparison reads.
The example logs `compare.bytesHashed` so you can distinguish a long hash pass from a hung sync.
Incorrect or adversarial size-matching, hash-mismatching metadata can force a full hash pass and
transfers in `sha1` mode. The SDK bounds local and B2 SHA-1 reads with an idle/no-progress timeout,
adds an absolute deadline to untrusted B2 verification downloads, rejects non-regular local files,
and bounds local reads to the scanned size. Untrusted B2 verification also refuses to read more
bytes than the selected version's `contentLength`; set `sha1VerificationMaxBytes` in code when you
need a lower absolute ceiling for large-object verification.

### Upload with a progress bar

Throttled CLI progress bar (10 Hz, ETA, throughput) wired into the SDK's `onProgress` callback. Useful as a starting point for any TTY UI or web progress widget.

```bash
npx tsx examples/node-with-progress.ts my-bucket ./big-file.zip
```

## Browser uploader

A two-part example: a Node.js backend that holds credentials and issues upload URLs, and a browser frontend that uploads files directly to B2.

```bash
# Terminal 1: start the backend
B2_BUCKET_ID=your-bucket-id npx tsx examples/browser-uploader/server.ts

# Terminal 2: start the frontend dev server
npx vite --config examples/browser-uploader/vite.config.ts
```

Open http://localhost:3000 and drag a file onto the drop zone.

The browser never sees the application key. Each upload gets a fresh single-use upload URL from the backend. See [browser-uploader/README.md](browser-uploader/README.md) for the full architecture.

## Cookbook

Production-shaped recipes that combine the SDK with adjacent infrastructure. Each lives in its own directory with a README explaining the trade-offs and audit-derived motivation.

### Presigned URLs with auth (downloads)

A Hono backend that gates B2 downloads behind your own access-control check, then mints a short-lived signed URL. The presigned URL is scoped to the file's prefix and expires after a configurable TTL, so a leaked token compromises one prefix, not the whole bucket.

```bash
B2_APPLICATION_KEY_ID=… B2_APPLICATION_KEY=… B2_BUCKET=my-bucket \
  npx tsx examples/node-presigned-with-auth/server.ts
```

See [node-presigned-with-auth/README.md](node-presigned-with-auth/README.md).

### React Native uploads via presigned URLs

A Hono backend that hands out single-use B2 upload URLs, plus a React Native client that uploads photos directly to B2 without ever holding the application key. Works on iOS, Android, web, Expo, and React Native for Windows. No native modules.

```bash
B2_APPLICATION_KEY_ID=… B2_APPLICATION_KEY=… B2_BUCKET=my-bucket \
  npx tsx examples/react-native-presigned/backend/server.ts
```

See [react-native-presigned/README.md](react-native-presigned/README.md).

### Cloudflare Workers + Bandwidth Alliance

Proxy B2 downloads from a Cloudflare Worker via the S3-compatible endpoint. Egress B2 → Cloudflare is free under the Bandwidth Alliance, and the Worker terminates SSL at Cloudflare's edge.

```bash
cd examples/cloudflare-bandwidth-alliance
wrangler deploy
```

See [cloudflare-bandwidth-alliance/README.md](cloudflare-bandwidth-alliance/README.md).

### Encrypted backup CLI

Production-shaped local-folder-to-B2 backup with client-side AES-GCM encryption (PBKDF2-derived KEK, per-file random DEK), manifest-diff for incremental uploads, and bounded concurrency. Snapshots survive crashes: the manifest persists per-file as uploads complete.

```bash
B2_APPLICATION_KEY_ID=… B2_APPLICATION_KEY=… B2_BACKUP_PASSPHRASE=… \
  npx tsx examples/node-backup-cli/backup.ts snapshot ./photos b2://my-bucket/photos
```

See [node-backup-cli/README.md](node-backup-cli/README.md).

### Plugin template for host frameworks

A framework-agnostic adapter showing the recommended way to write a B2 storage plugin for a host framework (NestJS, Strapi, Payload, Directus, AdminJS, n8n, etc.). Five methods (`put`, `get`, `delete`, `signedUrl`, `list`), no inheritance, no framework dependencies. Copy the directory, rename the class, graft on whatever lifecycle hooks your host expects.

See [node-plugin-template/README.md](node-plugin-template/README.md).
