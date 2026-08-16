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
- **Partner and Computer Backup examples**
  - [Authorize Partner API access](#authorize-partner-api-access) (`partner-authorize.ts`)
  - [Create a group member](#create-a-group-member) (`partner-create-group-member.ts`)
  - [List groups and members](#list-groups-and-members) (`partner-list-groups-and-members.ts`)
  - [Eject a group member](#eject-a-group-member) (`partner-eject-group-member.ts`)
  - [Reserve trial accounts](#reserve-trial-accounts) (`partner-reserve-trial-account.ts`, `partner-reserve-trial-accounts.ts`)
  - [List Computer Backup records](#list-computer-backup-records) (`backup-list-computers.ts`)
  - [Delete a Computer Backup record](#delete-a-computer-backup-record) (`backup-delete-computer.ts`)
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
# Node 22.3+ (with tsx)
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

SHA-1 comparison reads matching-size local files in full before transfers are executed. In normal
runs, untrusted B2 metadata also causes a selected-version download so the SDK can hash real B2
bytes before treating the pair as equal. The SDK does not cache that result across runs, so
unchanged multipart objects can incur full-object B2 download reads every `sha1` sync.
Dry-runs avoid those B2 content downloads and instead plan conservative transfer actions when
untrusted metadata cannot prove equality. `SYNC_CONCURRENCY`
bounds SHA-1 comparison workers, transfer workers, and queued transfer promises, but hashing and
transfer do not fully overlap. Changed uploads may read the same file again for transfer.
`SYNC_DRY_RUN=true` still performs local comparison reads. The example logs `compare.bytesHashed`
and `compare.bytesVerified` so you can distinguish hash and B2 verification work from a hung sync.
Incorrect or adversarial size-matching, hash-mismatching metadata can force a full hash pass and
transfers in `sha1` mode. To keep total disk and network work within `SYNC_CONCURRENCY`, SHA-1
batch preparation waits for prior transfer actions to drain instead of overlapping both phases.
The SDK bounds local and B2 SHA-1 reads with an idle/no-progress timeout, adds an absolute deadline
to untrusted B2 verification downloads, rejects non-regular local files, and bounds local reads to
the scanned size. Untrusted B2 verification also refuses to read more bytes than the selected
version's `contentLength`; set `sha1VerificationMaxBytes` in code when you need a lower per-file
ceiling for large-object verification. Objects over that byte ceiling, or objects that cannot be
verified before `sha1VerificationTimeoutMillis`, are skipped for that run.

### Upload with a progress bar

Throttled CLI progress bar (10 Hz, ETA, throughput) wired into the SDK's `onProgress` callback. Useful as a starting point for any TTY UI or web progress widget.

```bash
npx tsx examples/node-with-progress.ts my-bucket ./big-file.zip
```

## Partner and Computer Backup examples

These examples use the `/partner` and `/backup` SDK entry points. They require a Master Application Key:

```bash
export B2_MASTER_KEY_ID=your-master-key-id
export B2_MASTER_KEY=your-master-application-key
```

Partner group and member operations require Business Groups enabled and sales-approved Partner API access. Reserve trial account creation also requires the account prerequisites accepted by the API, including a valid SMS phone number. Computer Backup operations require Enterprise Controls for the target group; deleting a backup also requires the admin delete permission in those controls.

### Authorize Partner API access

Authorize with a Master Application Key and print the Partner and Computer Backup endpoints returned by the API.

```bash
npx tsx examples/partner-authorize.ts
```

### Create a group member

Create a new account and add it to a Partner group. The optional region must be one of the `Region` values exported by `@backblaze-labs/b2-sdk/partner`.

```bash
B2_CONFIRM_CREATE_GROUP_MEMBER=1 \
  npx tsx examples/partner-create-group-member.ts <group-id> <member-email> [region]
```

### List groups and members

Iterate Partner groups and active members through the SDK paginators. Set `B2_GROUP_PAGE_SIZE`, `B2_MEMBER_PAGE_SIZE`, `B2_MAX_GROUPS`, or `B2_MAX_MEMBERS_PER_GROUP` to tune page sizes and output limits.

```bash
npx tsx examples/partner-list-groups-and-members.ts [group-name]
```

### Eject a group member

Eject a member from a Partner group without deleting the account.

```bash
B2_CONFIRM_EJECT=1 \
  npx tsx examples/partner-eject-group-member.ts <group-id> <member-account-id> [replacement-email]
```

### Reserve trial accounts

Reserve one trial account:

```bash
B2_CONFIRM_RESERVE_TRIAL=1 \
  npx tsx examples/partner-reserve-trial-account.ts <email> <term-days> <storage-tb> [region]
```

Reserve multiple trial accounts with shared term, storage, and optional region settings:

```bash
B2_CONFIRM_RESERVE_TRIAL=1 \
B2_TRIAL_EMAILS=a@example.com,b@example.com \
B2_TRIAL_TERM_DAYS=7 \
B2_TRIAL_STORAGE_TB=1 \
  npx tsx examples/partner-reserve-trial-accounts.ts
```

### List Computer Backup records

List active Computer Backup records through the SDK paginator. Omit `account-id` to list backups for the authorized partner administrator account. Set `B2_COMPUTER_PAGE_SIZE` or `B2_MAX_COMPUTERS` to tune pagination and output limits.

```bash
npx tsx examples/backup-list-computers.ts [account-id]
```

### Delete a Computer Backup record

Delete a Computer Backup record by computer ID. Omit `account-id` when deleting a backup owned by the authorized partner administrator account.

```bash
B2_CONFIRM_DELETE_COMPUTER=1 \
  npx tsx examples/backup-delete-computer.ts <computer-id> [account-id]
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
