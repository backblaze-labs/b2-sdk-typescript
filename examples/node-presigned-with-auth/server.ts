/**
 * Permission-checked B2 download server.
 *
 * Reads the caller's identity from the `x-user` header (replace with real auth
 * for production), checks the policy, and either returns a 307 redirect to a
 * short-lived signed B2 URL or a 403.
 *
 * Uses Node's built-in `node:http` module so the example has no external
 * runtime dependencies — drop it into any framework (Hono, Express, Fastify,
 * Koa, …) by lifting the per-route logic into your framework's handler.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { B2Client } from '@backblaze-labs/b2-sdk'
import { B2Error } from '@backblaze-labs/b2-sdk/errors'
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
const bucketOrNull = await client.getBucket(bucketName)
if (!bucketOrNull) {
  console.error(`Bucket "${bucketName}" not found`)
  process.exit(1)
}
// Bind to a non-null `const` so the closure in `handleFile` sees a typed
// `Bucket` (TypeScript doesn't narrow `bucketOrNull` across the closure
// boundary even after the `!bucketOrNull` exit above).
const bucket = bucketOrNull

/** Reply helper: writes a status + plain-text body in one call. */
function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/**
 * Handle `GET /files/<key>`: issue a 307 redirect to a signed B2 URL if the
 * caller is authorized to read that key.
 *
 * 307 is used (rather than 302) so clients preserve the request method on
 * the redirect — we only allow GET here, but 307 is the strictly-correct
 * status for a same-method redirect.
 */
async function handleFile(
  fileKey: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const userIdHeader = req.headers['x-user']
  const userId = Array.isArray(userIdHeader) ? userIdHeader[0] : userIdHeader
  if (!userId) {
    send(res, 401, 'missing x-user header')
    return
  }

  const prefix = allowedPrefix(userId, fileKey)
  if (prefix === null) {
    send(res, 403, `forbidden: ${userId} cannot read ${fileKey}`)
    return
  }

  try {
    const minted = await mintDownloadUrl(client, bucket, fileKey, prefix, 60)
    res.writeHead(307, { Location: minted.url })
    res.end()
  } catch (err) {
    if (err instanceof B2Error) {
      send(res, 502, `B2 error: ${err.code} (request id ${err.requestId ?? 'n/a'})`)
      return
    }
    throw err
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url === undefined) {
    send(res, 405, 'method not allowed')
    return
  }

  if (req.url === '/healthz') {
    send(res, 200, 'ok')
    return
  }

  // Extract the file key from `/files/<key>`. URL.pathname decodes percent-
  // encoded characters, which matches how the policy table is keyed.
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/files/')) {
    send(res, 404, 'not found')
    return
  }
  const fileKey = decodeURIComponent(url.pathname.slice('/files/'.length))

  // Surface async errors from the route handler so an unhandled rejection
  // doesn't silently hang the response.
  handleFile(fileKey, req, res).catch((err) => {
    console.error('unhandled error:', err)
    if (!res.headersSent) send(res, 500, 'internal server error')
  })
})

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => {
  console.log(`node-presigned-with-auth listening on http://localhost:${port}`)
  console.log(`  curl 'http://localhost:${port}/files/photos/cat.jpg' -H 'x-user: alice'`)
})
