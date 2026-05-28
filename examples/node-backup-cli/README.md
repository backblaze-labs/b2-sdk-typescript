# Encrypted backup CLI

Production-shaped local-folder-to-B2 backup. Mirrors the pattern of `openclaw-b2-sync-backup` (the most polished backup tool in the npm B2 ecosystem audit) but written from scratch on `@backblaze-labs/b2-sdk`.

## What it does

```bash
b2-backup snapshot ./photos b2://my-bucket/photos
b2-backup snapshot ./photos b2://my-bucket/photos --since 2026-04-01
b2-backup restore  b2://my-bucket/photos ./restored
```

- **Manifest-diff**: keeps a `.b2-backup.json` manifest of `{ path, size, mtime, sha1 }` per file. On each run, only files whose sha1 changed get uploaded.
- **Encryption at rest**: every file is AES-GCM-encrypted with a per-file random key, and the key is wrapped with a master KEK derived from a passphrase via PBKDF2.
- **Bounded concurrency**: 8 parallel uploads by default, configurable via `--concurrency`.
- **Retry built-in**: every B2 request goes through the SDK's `RetryTransport` (exponential backoff, jitter, `Retry-After` honoured) so transient 503s don't crash the run.
- **Resume across runs**: a crashed snapshot doesn't lose the files it already finished. The manifest is updated as each upload succeeds, so the next run only re-uploads what's still missing.

## What "production-shaped" means here

Backup is one of the most common B2 applications, and it has a handful of properties that are easy to get wrong if you start from scratch. This example bakes them in by default:

- **Encryption is on, not opt-in.** Every file is wrapped with a per-file random DEK before it leaves the machine; B2 only ever sees ciphertext.
- **One DEK per file, not one for the whole repo.** A leak of one ciphertext doesn't compromise the others.
- **The DEK is *never* derived from the filename or path.** A key derived from a stable input lets an attacker who learns one mapping decrypt everything.
- **Resume is server-side.** A crash mid-snapshot doesn't force a full re-upload — the next run picks up where the manifest left off.
- **Manifest-diff** keeps each run incremental: only files whose plaintext SHA-1 changed get re-uploaded.

The whole flow fits in under 600 lines with a passphrase-derived KEK and per-file DEKs.

## Files

- `backup.ts`: the CLI entrypoint and command dispatch.
- `manifest.ts`: `.b2-backup.json` reader/writer + diff computation.
- `crypto.ts`: AES-GCM wrapping with PBKDF2-derived KEK + per-file DEK.
- `worker.ts`: bounded-concurrency upload/download worker pool.

## Cryptographic design

- **Master KEK**: PBKDF2-SHA-256, 600,000 iterations (OWASP 2024 guidance), 32-byte derived key. Salt stored in `.b2-backup.json` per repository.
- **Per-file DEK**: 32 bytes from `crypto.getRandomValues`. AES-GCM with 12-byte random IV.
- **Wrapped DEK + IV** stored as B2 `fileInfo` (`X-Bz-Info-dek` and `X-Bz-Info-iv`) so it travels with the encrypted bytes.
- **Authentication tag** appended to ciphertext (Web Crypto's AES-GCM does this automatically).

The SDK's [`EncryptionKey`](../../src/types/encryption.ts) class is intentionally **not** used here: that's for SSE-C (server-side encryption with B2 holding the cipher key). This example does **client-side** encryption: the bytes B2 sees are already ciphertext. B2 never holds the key.

## What's NOT in this example

- **Incremental block-level diff** (rsync-style). Files are uploaded whole; if a single byte changes, the entire file re-uploads. Block-level diff is doable with the multipart API and per-part SHA-1s but is significantly more code.
- **Snapshot / versioning** semantics. Each run overwrites the latest version; B2's built-in file versioning serves as the snapshot history. Pair with `bucket.listFileVersions()` to navigate.
- **Cloud-to-cloud sync.** Use `bucket.copyLargeFile()` for that.

## Running

```bash
export B2_APPLICATION_KEY_ID=…
export B2_APPLICATION_KEY=…
export B2_BACKUP_PASSPHRASE=…

npx tsx examples/node-backup-cli/backup.ts snapshot ./photos b2://my-bucket/photos
```

The first run uploads everything. Subsequent runs only upload changed files. The `.b2-backup.json` manifest is written next to the source folder and uploaded to B2 as `<prefix>/.b2-backup.json` so a fresh machine can `restore` against the same prefix.
