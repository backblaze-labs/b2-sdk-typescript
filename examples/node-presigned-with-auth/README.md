# Presigned downloads with permission checks

The most common B2 security mistake: hand out raw download authorization tokens (or worse, the application key) to the client.

The right shape:

```
Browser ─── GET /file/<id> ───►  Your backend
                                 ├─ check user permission
                                 ├─ if OK, mint a short-lived B2 download
                                 │  authorization scoped to the file's prefix
                                 ├─ return a 302 to the signed B2 URL
                                 │  (or proxy the bytes through)
                                 ▼
Browser ◄─── 302 to B2 ────── B2 serves the file
```

This example shows the safe shape using `@backblaze-labs/b2-sdk` — the application key never leaves the backend, the signed URL is scoped to a single file-name prefix, and the token is short-lived enough that a leak's blast radius is bounded.

## Files

- `server.ts`: tiny `node:http` server that runs the `x-user`-header check, mints the B2 download authorization, and 307-redirects to the signed URL. The example uses `node:http` so it has no external runtime dependencies; drop the per-route logic into Hono / Express / Fastify / Koa as-is.
- `mint.ts`: pure function that, given a (logged-in user, file key, bucket), produces a download URL with a short expiry. Exported so it's easy to unit-test independently of the HTTP layer.
- `policy.ts`: placeholder permission table mapping user → allowed prefixes. Replace with your real ACL store (Postgres, Redis, whatever).

## Running

```bash
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy B2_BUCKET=my-bucket \
  npx tsx examples/node-presigned-with-auth/server.ts
```

Then:

```bash
# alice can read everything under photos/
curl -i 'http://localhost:8787/files/photos/cat.jpg' -H 'x-user: alice'

# bob cannot: returns 403
curl -i 'http://localhost:8787/files/photos/cat.jpg' -H 'x-user: bob'
```

## Why this shape

- **The application key never leaves the server.** Only short-lived download tokens reach the client.
- **The token is scoped to a file-name prefix**, so even if it leaks, the blast radius is one prefix, not the entire bucket.
- **The token is short-lived** (60 seconds by default: long enough to follow a redirect, short enough to be useless if logged).
- **The 302 redirect** means B2 serves the bytes, not your backend: egress doesn't flow through your server.
- **No client-side B2 SDK needed.** The browser just follows a redirect.

## What to add for production

- Replace `policy.ts` with your real authorization (e.g. a per-bucket ACL keyed by user role).
- Cache the B2 client's authorization token (the SDK's `accountInfo` already does; survives `setAuth` calls). For multi-instance deployments, share via `FileAccountInfo` or a Redis-backed `AccountInfo`.
- Rate-limit the `/files/*` route.
- Log `request_id` from any B2 error (`err.requestId`) so you can correlate with B2 support.
- For the higher-security tier, **proxy the bytes** through your backend instead of redirecting. Lower egress savings but lets you audit-log every byte served. The `bucket.download()` method returns a `ReadableStream` you can pipe straight into the response.
