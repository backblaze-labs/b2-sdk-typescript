/**
 * Minimal backend that holds B2 credentials and issues upload URLs to the browser.
 *
 * The browser never sees the application key. It requests a short-lived upload URL
 * from this server, then uploads the file directly to B2.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=... B2_APPLICATION_KEY=... B2_BUCKET_ID=... npx tsx server.ts
 */

import { createServer } from 'node:http'
import { B2Client } from '../../src/index.js'
import type { BucketId } from '../../src/types/ids.js'

const keyId = process.env.B2_APPLICATION_KEY_ID
const appKey = process.env.B2_APPLICATION_KEY
const bucketId = process.env.B2_BUCKET_ID

if (!keyId || !appKey || !bucketId) {
  console.error('Set B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET_ID')
  process.exit(1)
}

const client = new B2Client({ applicationKeyId: keyId, applicationKey: appKey })
await client.authorize()
console.log('Authorized with B2')

const PORT = Number(process.env.PORT) || 3001

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/api/upload-url' && req.method === 'GET') {
    try {
      const uploadUrl = await client.raw.getUploadUrl(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucketId as BucketId },
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          uploadUrl: uploadUrl.uploadUrl,
          authorizationToken: uploadUrl.authorizationToken,
        }),
      )
    } catch (err) {
      console.error('Failed to get upload URL:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to get upload URL' }))
    }
    return
  }

  if (req.url === '/api/list-files' && req.method === 'GET') {
    try {
      const buckets = await client.listBuckets({ bucketId: bucketId as BucketId })
      const bucket = buckets[0]
      if (!bucket) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bucket not found' }))
        return
      }
      const listing = await bucket.listFileNames({ maxFileCount: 100 })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          listing.files.map((f) => ({
            fileName: f.fileName,
            size: f.contentLength,
            uploadTimestamp: f.uploadTimestamp,
            contentType: f.contentType,
          })),
        ),
      )
    } catch (err) {
      console.error('Failed to list files:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to list files' }))
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`Upload URL server listening on http://localhost:${PORT}`)
  console.log('  GET /api/upload-url  - get a fresh B2 upload URL')
  console.log('  GET /api/list-files  - list files in the bucket')
})
