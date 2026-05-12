# Browser Uploader Example

Upload files directly from the browser to Backblaze B2. The architecture keeps your application key safe on the server while allowing the browser to upload directly to B2.

## How it works

1. **Server** (`server.ts`): A Node.js HTTP server that holds B2 credentials and exposes `/api/upload-url` to issue short-lived upload URLs.
2. **Browser** (`upload.ts` + `index.html`): Fetches an upload URL from the server, computes SHA-1 via WebCrypto, and POSTs the file directly to B2.

The browser never sees the application key. Each upload gets a fresh `b2_get_upload_url` token that is scoped to a single file upload.

## Setup

```bash
# From the SDK root
pnpm install
pnpm build

# Start the backend (holds B2 credentials)
B2_APPLICATION_KEY_ID=your-key-id \
B2_APPLICATION_KEY=your-app-key \
B2_BUCKET_ID=your-bucket-id \
npx tsx examples/browser-uploader/server.ts

# In another terminal, start the frontend dev server
npx vite --config examples/browser-uploader/vite.config.ts
```

Open http://localhost:3000, drag a file onto the drop zone, and watch it upload to B2.

## Architecture

```
Browser (localhost:3000)          Server (localhost:3001)          Backblaze B2
       |                                 |                            |
       |-- GET /api/upload-url --------->|                            |
       |                                 |-- b2_get_upload_url ------>|
       |                                 |<-- { uploadUrl, token } ---|
       |<-- { uploadUrl, token } --------|                            |
       |                                                              |
       |-- POST uploadUrl (file bytes, SHA-1) ----------------------->|
       |<-- { fileId, fileName, ... } --------------------------------|
```

The upload URL is single-use. For multiple files, the browser requests a new URL for each one.
