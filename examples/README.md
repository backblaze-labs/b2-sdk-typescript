# Examples

Runnable examples demonstrating `@backblaze/b2-sdk` usage patterns.

## Prerequisites

All examples require B2 credentials via environment variables:

```bash
export B2_APPLICATION_KEY_ID=your-key-id
export B2_APPLICATION_KEY=your-application-key
```

Run from the SDK root directory. Examples use `npx tsx` for direct TypeScript execution.

## Node.js examples

### List buckets

List all buckets in your B2 account.

```bash
npx tsx examples/list-buckets.ts
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

Sync a local directory to a B2 bucket prefix. Supports modtime/size comparison, delete mode, dry-run, and configurable concurrency.

```bash
npx tsx examples/sync-cli.ts ./local-dir my-bucket backup/

# With options
SYNC_MODE=size SYNC_DELETE=true SYNC_CONCURRENCY=8 SYNC_DRY_RUN=true \
  npx tsx examples/sync-cli.ts ./local-dir my-bucket backup/
```

| Env var | Default | Description |
|---------|---------|-------------|
| `SYNC_MODE` | `modtime` | Compare mode: `modtime`, `size`, or `none` |
| `SYNC_DELETE` | `false` | Delete remote files not present locally |
| `SYNC_CONCURRENCY` | `4` | Parallel upload/download workers |
| `SYNC_DRY_RUN` | `false` | Print actions without executing them |

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
