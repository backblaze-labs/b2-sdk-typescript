/**
 * Mints single-use B2 upload URLs for the React Native client.
 *
 * The client POSTs to /sign with `{ fileName, contentType }` and receives a
 * one-time `uploadUrl` plus `authorizationToken`. The client then PUTs the
 * file bytes directly to B2: the application key never reaches the device.
 */

import { B2Client } from '@backblaze-labs/b2-sdk'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const keyId = process.env.B2_APPLICATION_KEY_ID
const key = process.env.B2_APPLICATION_KEY
const bucketName = process.env.B2_BUCKET
if (!keyId || !key || !bucketName) {
  console.error('Set B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET')
  process.exit(1)
}

const client = new B2Client({ applicationKeyId: keyId, applicationKey: key })
await client.authorize()
const bucket = await client.getBucket(bucketName)
if (!bucket) {
  console.error(`Bucket "${bucketName}" not found`)
  process.exit(1)
}

const app = new Hono()

// Permissive CORS for development: lock down to your app's domain / Expo
// dev server in production.
app.use('/*', cors({ origin: '*', allowMethods: ['POST', 'GET', 'OPTIONS'] }))

app.post('/sign', async (c) => {
  let body: { fileName?: string; contentType?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.text('invalid JSON', 400)
  }
  const fileName = body.fileName
  if (!fileName || typeof fileName !== 'string') {
    return c.text('fileName is required', 400)
  }

  // Hand-roll the upload-URL fetch via raw client. The SDK exposes
  // getUploadUrl directly so we get a single-use URL + token to relay.
  const uploadInfo = await client.raw.getUploadUrl(
    client.accountInfo.getApiUrl(),
    client.accountInfo.getAuthToken(),
    { bucketId: bucket.id },
  )

  return c.json({
    uploadUrl: uploadInfo.uploadUrl,
    authorizationToken: uploadInfo.authorizationToken,
    fileName,
    // Echo back so the client doesn't have to remember.
    contentType: body.contentType ?? 'application/octet-stream',
  })
})

app.get('/healthz', (c) => c.text('ok'))

const port = Number(process.env.PORT ?? 8788)
serve({ fetch: app.fetch, port })
console.log(`react-native-presigned backend listening on http://localhost:${port}`)
