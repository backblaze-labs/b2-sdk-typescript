/**
 * Node `--import` preload for example-program tests.
 *
 * Routes `globalThis.fetch` to the standalone b2-simulator
 * (https://github.com/backblaze-labs/b2-simulator) that the parent test
 * started and reset, seeds it from the JSON in `EXAMPLE_SIM_SEED`, so an
 * unmodified example (which builds its own default `B2Client`) runs offline
 * with no credentials. The parent passes the server's origins in
 * `B2SIM_API_URL` and `B2SIM_CONTROL_URL` (`resetRemoteSimulator()` from
 * `src/test-utils/remote-simulator.ts` gives both).
 *
 * Every request goes to the simulator, whatever host the example used, so
 * nothing reaches the network. The simulator hands out URLs on its loopback
 * `http` origin, which the SDK's default SSRF guard rejects; they are
 * presented as a Backblaze pod host and mapped back on the way in.
 *
 * Seed shape:
 *   { buckets: [{ name, files: [{ name, text?, base64?, fileInfo? }] }],
 *     failUploads?: boolean }   // every b2_upload_file returns HTTP 400
 *
 * When `EXAMPLE_SIM_UPLOAD_TRACE` names a file, every `b2_upload_file` request
 * appends one JSON line `{ "fileName": <decoded X-Bz-File-Name>, "status": <HTTP status> }`
 * to it. Credentials and upload tokens are never recorded.
 *
 * Uses built output by default; EXAMPLE_SIM_SOURCE=1 loads source through tsx.
 */
import { appendFileSync } from 'node:fs'

const fromSource = process.env.EXAMPLE_SIM_SOURCE === '1'
const { B2Client, BucketType, FetchTransport } = await import(
  fromSource ? '../../../src/index.ts' : '../../../dist/index.js'
)
const { BufferSource } = await import(
  fromSource ? '../../../src/streams/index.ts' : '../../../dist/streams/index.js'
)

const SIM_ORIGIN = process.env.B2SIM_API_URL
const CONTROL_URL = process.env.B2SIM_CONTROL_URL
if (SIM_ORIGIN === undefined || CONTROL_URL === undefined) {
  throw new Error(
    'fetch-simulator-preload: set B2SIM_API_URL and B2SIM_CONTROL_URL to a running standalone b2-simulator (resetRemoteSimulator() in the parent test)',
  )
}
const simFetch = globalThis.fetch

const uploadTrace = process.env.EXAMPLE_SIM_UPLOAD_TRACE
const seed = JSON.parse(process.env.EXAMPLE_SIM_SEED ?? '{}')

const setup = new B2Client({
  applicationKeyId: 'seed-key',
  applicationKey: 'seed-secret',
  realm: SIM_ORIGIN,
  transport: new FetchTransport(),
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
  const response = await simFetch(`${CONTROL_URL}/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      on: 'b2_upload_file',
      status: 400,
      code: 'bad_request',
      message: 'simulated upload failure',
    }),
  })
  if (response.status !== 200) {
    throw new Error(`fetch-simulator-preload: POST /faults answered ${response.status}`)
  }
}

const POD_ORIGIN = 'https://pod-000-0000-00.backblaze.com'

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const parsed = new URL(rawUrl)
  if (
    process.env.EXAMPLE_SIM_MANIFEST_FAILURE === '1' &&
    parsed.pathname.endsWith('/.b2-backup.json')
  ) {
    return new Response(
      JSON.stringify({ status: 403, code: 'access_denied', message: 'manifest access denied' }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }
  const url = SIM_ORIGIN + parsed.pathname + parsed.search
  const response =
    typeof input === 'string' || input instanceof URL
      ? await simFetch(url, init)
      : await simFetch(new Request(url, input), init)
  if (uploadTrace !== undefined && parsed.pathname.includes('b2_upload_file')) {
    const encodedName = new Headers(init.headers).get('x-bz-file-name') ?? ''
    appendFileSync(
      uploadTrace,
      `${JSON.stringify({ fileName: decodeURIComponent(encodedName), status: response.status })}\n`,
    )
  }
  const nullBody = response.status === 204 || response.status === 304
  if (!nullBody && (response.headers.get('content-type') ?? '').includes('application/json')) {
    let text = (await response.text()).replaceAll(SIM_ORIGIN, POD_ORIGIN)
    if (parsed.pathname.includes('b2_authorize_account') && process.env.EXAMPLE_SIM_API_URL) {
      const auth = JSON.parse(text)
      auth.apiInfo.storageApi.apiUrl = process.env.EXAMPLE_SIM_API_URL
      text = JSON.stringify(auth)
    }
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    return new Response(text, { status: response.status, headers })
  }
  return response
}
