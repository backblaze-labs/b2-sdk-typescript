/**
 * Cloudflare Worker that proxies GET requests to a Backblaze B2 bucket over
 * the Bandwidth Alliance link (free egress between Cloudflare and B2).
 *
 * Deployed via wrangler. Secrets `B2_APPLICATION_KEY_ID` and
 * `B2_APPLICATION_KEY` plus environment vars `B2_BUCKET` and `B2_REGION` come
 * from `wrangler.toml`.
 *
 * The Worker uses the S3-compatible B2 endpoint and signs requests with the
 * application key id/secret as `Authorization: Basic ...`. For more advanced
 * scenarios (presigned URLs, range-aware caching, typed errors), import from
 * `@backblaze/b2-sdk/s3` instead: it works in Workers without changes.
 */

interface Env {
  B2_APPLICATION_KEY_ID: string
  B2_APPLICATION_KEY: string
  B2_BUCKET: string
  /** e.g. `us-west-004` */
  B2_REGION: string
}

const STRIP_HEADERS = new Set([
  'x-bz-file-id',
  'x-bz-file-name',
  'x-bz-content-sha1',
  'x-amz-id-2',
  'x-amz-request-id',
])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const key = url.pathname.replace(/^\/+/, '')
    if (!key) return new Response('not found', { status: 404 })

    const b2Url = `https://${env.B2_BUCKET}.s3.${env.B2_REGION}.backblazeb2.com/${key}`
    const basic = btoa(`${env.B2_APPLICATION_KEY_ID}:${env.B2_APPLICATION_KEY}`)

    // Forward Range so big-file partial requests work end-to-end.
    const upstreamHeaders: Record<string, string> = { Authorization: `Basic ${basic}` }
    const range = request.headers.get('Range')
    if (range) upstreamHeaders['Range'] = range

    // Let Cloudflare cache the response for an hour. Tune to your churn rate.
    const upstream = await fetch(b2Url, {
      method: request.method,
      headers: upstreamHeaders,
      cf: { cacheTtl: 3600, cacheEverything: true },
    })

    // Re-emit response without B2-internal headers.
    const clientHeaders = new Headers()
    for (const [name, value] of upstream.headers) {
      if (!STRIP_HEADERS.has(name.toLowerCase())) clientHeaders.set(name, value)
    }
    if (!clientHeaders.has('Cache-Control')) {
      clientHeaders.set('Cache-Control', 'public, max-age=3600')
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: clientHeaders,
    })
  },
}
