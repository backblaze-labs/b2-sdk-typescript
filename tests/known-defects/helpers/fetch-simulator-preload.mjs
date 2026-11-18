/**
 * Node `--import` preload for example-program tests.
 *
 * Starts an in-memory B2Simulator (from the built `dist/`), seeds it from the
 * JSON in `EXAMPLE_SIM_SEED`, and routes `globalThis.fetch` into the simulator
 * transport so an unmodified example (which builds its own default
 * `B2Client`) runs offline with no credentials.
 *
 * Seed shape:
 *   { buckets: [{ name, files: [{ name, text?, base64?, fileInfo? }] }],
 *     failUploads?: boolean }   // every b2_upload_file returns HTTP 400
 *
 * When `EXAMPLE_SIM_UPLOAD_TRACE` names a file, every `b2_upload_file` request
 * appends one JSON line `{ "fileName": <decoded X-Bz-File-Name>, "status": <HTTP status> }`
 * to it. Credentials and upload tokens are never recorded.
 *
 * Requires `pnpm build` first (same prerequisite as `.github/workflows/examples.yml`).
 */
import { appendFileSync } from 'node:fs'
import { B2Client, BucketType } from '../../../dist/index.js'
import { B2Simulator } from '../../../dist/simulator/index.js'
import { BufferSource } from '../../../dist/streams/index.js'

const uploadTrace = process.env.EXAMPLE_SIM_UPLOAD_TRACE
const seed = JSON.parse(process.env.EXAMPLE_SIM_SEED ?? '{}')
const sim = new B2Simulator()
const transport = sim.transport()

const setup = new B2Client({
  applicationKeyId: 'seed-key',
  applicationKey: 'seed-secret',
  transport,
})
await setup.authorize()
for (const spec of seed.buckets ?? []) {
  const bucket = await setup.createBucket({
    bucketName: spec.name,
    bucketType: BucketType.AllPrivate,
  })
  for (const file of spec.files ?? []) {
    const data =
      file.base64 !== undefined
        ? Buffer.from(file.base64, 'base64')
        : Buffer.from(file.text ?? '', 'utf8')
    await bucket.upload({
      fileName: file.name,
      source: new BufferSource(new Uint8Array(data)),
      ...(file.fileInfo !== undefined ? { fileInfo: file.fileInfo } : {}),
    })
  }
}
if (seed.failUploads === true) {
  sim.injectFailure({
    on: 'b2_upload_file',
    status: 400,
    code: 'bad_request',
    message: 'simulated upload failure',
  })
}

// fetch hands us a Headers object (lower-cased keys); the simulator reads the
// canonical B2 spellings (`Authorization`, `X-Bz-File-Name`, ...).
function canonicalHeaders(headers) {
  const out = {}
  for (const [key, value] of new Headers(headers).entries()) {
    const name = key.replace(/(^|-)([a-z])/g, (_m, dash, ch) => dash + ch.toUpperCase())
    out[name] = value
  }
  return out
}

// The simulator hands out upload URLs on http://localhost:0, which the SDK's
// default SSRF guard rejects. Present them as a Backblaze pod host and map
// them back when the request reaches the simulator.
const SIM_UPLOAD_ORIGIN = 'http://localhost:0'
const POD_ORIGIN = 'https://pod-000-0000-00.backblaze.com'

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  // Compare the parsed origin exactly (not a string prefix) so only the pod host is remapped.
  const parsed = new URL(rawUrl)
  const url =
    parsed.origin === POD_ORIGIN ? SIM_UPLOAD_ORIGIN + parsed.pathname + parsed.search : rawUrl
  const response = await transport.send({
    url,
    method: init.method ?? 'GET',
    ...(init.headers !== undefined ? { headers: canonicalHeaders(init.headers) } : {}),
    ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
    ...(init.signal !== undefined ? { signal: init.signal } : {}),
  })
  if (uploadTrace !== undefined && url.includes('b2_upload_file')) {
    const encodedName = canonicalHeaders(init.headers ?? {})['X-Bz-File-Name'] ?? ''
    appendFileSync(
      uploadTrace,
      `${JSON.stringify({ fileName: decodeURIComponent(encodedName), status: response.status })}\n`,
    )
  }
  const nullBody = response.status === 204 || response.status === 304
  if (!nullBody && (response.headers.get('content-type') ?? '').includes('application/json')) {
    const text = (await response.text()).replaceAll(SIM_UPLOAD_ORIGIN, POD_ORIGIN)
    return new Response(text, { status: response.status, headers: response.headers })
  }
  return new Response(nullBody ? null : response.body, {
    status: response.status,
    headers: response.headers,
  })
}
