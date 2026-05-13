# React Native uploads via presigned URLs

For most React Native apps, you don't need a native module to upload to B2. You need a backend that mints presigned upload URLs and a client that PUTs to them. A pure-JS `fetch`-based upload is fine up to a few hundred MB and works in Expo, bare React Native, and React Native for Windows without any native code.

This example pairs a tiny backend (built with `@backblaze/b2-sdk`) with a React Native client that uploads photos to B2 without ever touching the application key.

## Architecture

```
┌─────────────┐                   ┌────────────────┐
│  RN client  │── POST /sign ────►│  Your backend  │
│             │                   │  (Hono + B2)   │
│             │◄── { uploadUrl,   │                │
│             │     authToken }   │                │
│             │                   └────────────────┘
│             │
│             │── POST <uploadUrl> ─────────► B2
│             │   X-Bz-File-Name, X-Bz-Content-Sha1
└─────────────┘
```

## Why this is the right shape

- **The application key never ships in the app bundle.** A bundled key would let anyone who extracts your APK / IPA upload to (or wipe) your bucket.
- **The signed upload URL is single-use and short-lived**: it's invalidated as soon as B2 sees a 200 on the upload, and expires after ~24 hours regardless.
- **The client uses bare `fetch`** to do the upload. No native modules. Works in iOS, Android, web, Expo, and React Native for Windows.
- **The backend can enforce policy** before minting (e.g. "this user has uploaded their quota for the day"). Try doing that with a baked-in key.

## Files

- `backend/server.ts`: Hono server with a `POST /sign` route that returns a `{ uploadUrl, authToken }` pair per request.
- `client/upload.ts`: pure function the RN app calls. Takes a `Blob` (from `expo-image-picker`, `react-native-image-picker`, or `react-native`'s native fetch), gets a URL from the backend, and PUTs.
- `client/App.tsx`: minimal example screen with an "Upload" button.

## Why no native module

Native modules in RN are useful when you need:
- True background uploads that survive app suspension (iOS `URLSession`, Android `WorkManager`).
- Strict memory pressure (uploading 4 GB videos on a 2 GB phone).
- Native progress callbacks that bypass the JS thread.

Most apps need none of those. A `fetch`-based upload is fine up to a few hundred MB, the JS thread is mostly idle during network IO, and progress events from `fetch` are sufficient.

For the cases where you DO need a native module, the same backend works: point your native uploader at `/sign` and PUT to the returned URL.

## Backend-only run

```bash
B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy B2_BUCKET=my-bucket \
  npx tsx examples/react-native-presigned/backend/server.ts
```

```bash
curl -X POST http://localhost:8788/sign \
  -H 'content-type: application/json' \
  -d '{"fileName":"photos/2026/snap.jpg","contentType":"image/jpeg"}'
```

Returns something like:

```json
{
  "uploadUrl": "https://pod-000-1024-08.backblaze.com/b2api/v3/b2_upload_file?bucketId=…",
  "authorizationToken": "4_…",
  "fileName": "photos/2026/snap.jpg"
}
```

The client then `fetch(uploadUrl, { method: 'POST', headers: { Authorization, 'X-Bz-File-Name', 'X-Bz-Content-Sha1', 'Content-Type' }, body: blob })` and reads the file version from the JSON response.

## Caveats

- The `X-Bz-Content-Sha1` header is required by B2. Compute it client-side with `crypto.subtle.digest('SHA-1', bytes)`, which works in modern RN via the same Web Crypto API the SDK uses internally.
- A single upload URL is single-use; if the upload fails, request a fresh URL from `/sign` and try again. The SDK's `upload-url-pool` handles this for you on the server; the RN client has to handle it manually.
- For files larger than ~100 MB, use the multipart flow instead. The backend can mint per-part URLs the same way the SDK does internally; see `backend/server.ts` for the large-file variant (commented out; wire it up when you need it).
