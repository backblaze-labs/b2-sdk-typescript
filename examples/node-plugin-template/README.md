# Plugin template: wrapping `@backblaze/b2-sdk` for a host framework

This is a starting point for anyone writing a B2 integration plugin for a host framework (NestJS, Strapi, NodeBB, n8n, Node-RED, Payload, AdminJS, Directus, etc.). Build against the official SDK directly so your plugin gets retry, resume, typed errors, and B2-native primitives for free, and stays current as new B2 features land.

This template shows what a thin, framework-agnostic adapter over `@backblaze/b2-sdk` looks like. Copy the directory, rename the class, and graft on whatever lifecycle hooks your host framework expects.

## The shape

```ts
import { createStorage } from '@your-org/host-framework-b2-storage'

const storage = createStorage({
  applicationKeyId: process.env.B2_KEY_ID!,
  applicationKey: process.env.B2_KEY!,
  bucket: 'uploads',
  prefix: 'user-content/',
})

await storage.put('avatars/u-123.jpg', blob)
const stream = await storage.get('avatars/u-123.jpg')
await storage.delete('avatars/u-123.jpg')
const url = await storage.signedUrl('avatars/u-123.jpg', { ttlSeconds: 300 })
```

## Why this shape

Host frameworks already have their own storage abstractions (NestJS's `Storage` interface, Strapi's provider contract, Payload's `Adapter`, etc.). You don't need to reinvent the wheel: you need a B2-flavoured concrete implementation of the framework's existing interface.

The five methods in `storage.ts` (`put`, `get`, `delete`, `signedUrl`, `list`) cover what every host framework expects. Map them onto whatever method names your host calls.

## Files

- `storage.ts`: the framework-agnostic adapter. Takes a config object, exposes `put`/`get`/`delete`/`signedUrl`/`list`. Single class, no inheritance, no framework dependencies.
- `index.ts`: public surface. Exports `createStorage` and the config type.

## How to adapt this to your host framework

1. **Copy this directory** into your plugin package.
2. **Implement the host's storage interface** in a separate file (e.g. `nestjs-adapter.ts`) that *uses* `B2Storage` internally. Don't subclass. Compose.
3. **Forward the host's config** into `createStorage`. Most hosts pass a config object to their plugin loader; pluck the B2 fields out and hand them over.
4. **Match the host's lifecycle.** If the host has a `bootstrap()` / `onModuleInit()` / `register()` hook, call `storage.warmup()` there so `client.authorize()` runs once at startup instead of on the first request.

That's the entire integration. No re-implementing presigned URLs, no copy-pasting retry logic, no maintaining two different B2 client codepaths.

## What this template explicitly does NOT include

- **A framework dependency.** This is intentional. Plugins should depend on `@backblaze/b2-sdk` plus their host's plugin contract, nothing else. Adding a transitive React / Express / Hono dep here would force every consumer to accept it.
- **A built-in cache.** Storage adapters that cache file contents in memory are almost always wrong: the host's HTTP layer should cache via `Cache-Control` headers, not the adapter. The SDK does cache *upload URLs* (the SDK's `UploadUrlPool` recycles them across requests) which is the part that actually pays off.
- **Magic auto-detection.** Some plugins auto-detect Cloudflare vs Vercel vs Lambda environments and pick credential sources for you. This template makes the host pass credentials explicitly. Much easier to debug, much less surprise.

## Pitfalls to avoid

| Pitfall | Why it bites | What to do instead |
|---|---|---|
| Re-implementing retry inside the plugin | Retry logic is easy to get wrong (silent infinite loops on non-retryable errors, ignoring `Retry-After`, no jitter). The SDK's `RetryTransport` already handles 401 reauth, 503/408/429 backoff, jitter, and the `Retry-After` header. | Use `RetryTransport` (it wraps `FetchTransport` by default in `B2Client`). |
| Authorising once per request | `b2_authorize_account` is rate-limited per account; doing it on every upload guarantees you'll hit a 429 in production. | Call `client.authorize()` once at plugin init. |
| Generating presigned URLs by string-concatenating the master auth token | Master tokens are scoped to the application key — concatenating one into a download URL lets the holder access *any* file the key can reach, not just the one you intended. | Use `client.getDownloadAuthorization()` (scoped per prefix, time-limited) and embed that token. |
| Hard-coding the realm to `api.backblazeb2.com` | Breaks for accounts in the EU central region. | Let the SDK discover the realm via `b2_authorize_account` (the default). |
| Caching the `applicationKey` in memory across requests | Fine on its own — but stuffing it into a long-lived global where logs or error dumps might find it can leak credentials. | Treat it like any other secret. The SDK accepts it once and never logs it. |
