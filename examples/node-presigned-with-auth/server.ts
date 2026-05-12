/**
 * Permission-checked B2 download server.
 *
 * Reads the caller's identity from the `x-user` header (replace with real auth
 * for production), checks the policy, and either returns a 302 to a short-lived
 * signed B2 URL or a 403.
 */

import { B2Client } from '@backblaze/b2-sdk'
import { B2Error } from '@backblaze/b2-sdk/errors'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { mintDownloadUrl } from './mint.ts'
import { allowedPrefix } from './policy.ts'

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

// GET /files/<key>: issue a 302 redirect to a signed B2 URL if the caller
// is authorized to read that key.
app.get('/files/:key{.+}', async (c) => {
  const userId = c.req.header('x-user')
  if (!userId) return c.text('missing x-user header', 401)

  const fileKey = c.req.param('key')
  const prefix = allowedPrefix(userId, fileKey)
  if (prefix === null) {
    return c.text(`forbidden: ${userId} cannot read ${fileKey}`, 403)
  }

  try {
    const minted = await mintDownloadUrl(client, bucket, fileKey, prefix, 60)
    // Use 307 so clients preserve method on the redirect (we only allow GET
    // here, but 307 is the strictly-correct status for a same-method redirect).
    return c.redirect(minted.url, 307)
  } catch (err) {
    if (err instanceof B2Error) {
      return c.text(`B2 error: ${err.code} (request id ${err.requestId ?? 'n/a'})`, 502)
    }
    throw err
  }
})

app.get('/healthz', (c) => c.text('ok'))

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
console.log(`node-presigned-with-auth listening on http://localhost:${port}`)
console.log(`  curl 'http://localhost:${port}/files/photos/cat.jpg' -H 'x-user: alice'`)
