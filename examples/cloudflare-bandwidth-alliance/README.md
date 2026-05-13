# Cloudflare Workers · Bandwidth Alliance proxy

Backblaze B2 and Cloudflare are members of the [Bandwidth Alliance](https://www.cloudflare.com/bandwidth-alliance/), which means **egress from B2 to Cloudflare is free**. Putting a Cloudflare Worker (or just a CDN-cached domain) in front of your B2 bucket can drop your egress bill to zero.

For any read-heavy workload, the savings can be substantial — Cloudflare's edge cache absorbs repeat requests, and origin fetches from B2 to Cloudflare don't count against your B2 egress bill.

## What this Worker does

- Proxies `GET /<key>` to `https://<your-bucket>.s3.us-west-004.backblazeb2.com/<key>` (or whatever region your bucket lives in).
- Authenticates upstream via a stored application key (held in Workers Secrets, not in the script).
- Sets `Cache-Control: public, max-age=3600` so Cloudflare's edge cache absorbs repeat requests.
- Strips B2-internal response headers (`x-bz-*`) before responding to the client.
- Honors `Range` requests for byte-range downloads.
- Surfaces typed B2 errors with their `request_id` for support correlation.

The Worker uses the **S3-compatible** B2 endpoint because S3 over HTTPS works seamlessly in the Workers runtime via `fetch`. The SDK's `@backblaze/b2-sdk/s3` subpath also works inside a Worker if you need richer control (presigning, custom retry, typed errors).

## Files

- `worker.ts`: the Workers handler.
- `wrangler.toml`: sample Wrangler config. Adjust the bucket name and region.

## Deploy

```bash
npm install -g wrangler
cd examples/cloudflare-bandwidth-alliance
wrangler secret put B2_APPLICATION_KEY_ID
wrangler secret put B2_APPLICATION_KEY
wrangler deploy
```

Then point your `cdn.yourdomain.com` at the deployed Worker via Cloudflare DNS, and `GET https://cdn.yourdomain.com/path/to/file.jpg` will:

1. Hit Cloudflare's edge cache first (free if cached).
2. Miss → Worker forwards to B2 over the free Bandwidth Alliance link.
3. Response cached at the edge for the next hit.

## What's NOT in this example

- **Signed URLs.** This is a public-read Worker. Pair with [`node-presigned-with-auth/`](../node-presigned-with-auth) for permission-checked downloads.
- **Cache invalidation on file update.** Use B2 event notifications (`bucket.setNotificationRules`) to fire a Cloudflare cache-purge webhook.
- **Range-request optimization.** For large videos, the Worker proxies a single range at a time. For HLS-style streaming, consider Cloudflare Stream instead.

## Why use the SDK in a Worker at all

The Worker runtime supports `fetch` directly: you don't strictly need the SDK to proxy a GET. But the SDK gives you:

- Typed B2 errors with `.code` / `.retryable` / `.requestId` (huge for triage).
- Built-in retry + backoff for 503/429 from B2 (rare but happens).
- The same upload code that works in Node/browsers also works here: you can write upload-to-B2 Workers without rewriting client code.
- The in-memory `B2Simulator` for unit tests (Workers tests via Miniflare).

This example shows both flavors: a bare-`fetch` proxy and an SDK-backed alternative.
