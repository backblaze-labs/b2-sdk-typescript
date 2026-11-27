// Persists simulator uploads across CLI processes for backup and restore tests.
// Each process gets an empty standalone b2-simulator (reset by the parent test,
// which passes its origins in B2SIM_API_URL / B2SIM_CONTROL_URL); the uploads
// recorded in REVIEW_STATE are replayed into it first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { B2Client, BucketType, FetchTransport } from '../../src/index.ts'
import { BufferSource } from '../../src/streams/index.ts'

const simOrigin = process.env.B2SIM_API_URL
if (simOrigin === undefined) {
  throw new Error(
    'backup-state-preload: set B2SIM_API_URL to a running standalone b2-simulator (resetRemoteSimulator() in the parent test)',
  )
}
const simFetch = globalThis.fetch
const statePath = process.env.REVIEW_STATE
const entries = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
const setup = new B2Client({
  applicationKeyId: 'test',
  applicationKey: 'test',
  realm: simOrigin,
  transport: new FetchTransport(),
})
await setup.authorize()
const bucket = await setup.createBucket({
  bucketName: 'review-bucket',
  bucketType: BucketType.AllPrivate,
})
for (const item of entries) {
  await bucket.upload({
    fileName: item.name,
    source: new BufferSource(new Uint8Array(Buffer.from(item.base64, 'base64'))),
    fileInfo: item.info,
  })
}
const podOrigin = 'https://pod-000-0000-00.backblaze.com'
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const parsed = new URL(raw)
  // Every request goes to the simulator, whatever host the example used.
  const url = simOrigin + parsed.pathname + parsed.search
  const headers = new Headers(init.headers)
  const isUpload = parsed.pathname.includes('b2_upload_file')
  const fileName = decodeURIComponent(headers.get('x-bz-file-name') ?? '')
  if (isUpload && process.env.REVIEW_FAIL_FILE === fileName) {
    return new Response(
      JSON.stringify({ status: 400, code: 'bad_request', message: 'simulated upload failure' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  let body = init.body
  if (isUpload) body = new Uint8Array(await new Response(body).arrayBuffer())
  const { duplex: _duplex, ...rest } = init
  const response = await simFetch(url, {
    ...rest,
    ...(body != null ? { body } : {}),
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  })
  if (isUpload && response.status === 200) {
    const info = {}
    for (const [key, value] of headers.entries())
      if (key.startsWith('x-bz-info-')) info[key.slice(10)] = decodeURIComponent(value)
    const index = entries.findIndex((item) => item.name === fileName)
    const item = { name: fileName, base64: Buffer.from(body).toString('base64'), info }
    if (index < 0) entries.push(item)
    else entries[index] = item
    writeFileSync(statePath, JSON.stringify(entries))
  }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    let data = (await response.text()).replaceAll(simOrigin, podOrigin)
    if (parsed.pathname.includes('b2_authorize_account') && process.env.REVIEW_API_HOST) {
      const auth = JSON.parse(data)
      auth.apiInfo.storageApi.apiUrl = process.env.REVIEW_API_HOST
      data = JSON.stringify(auth)
    }
    const out = new Headers(response.headers)
    out.delete('content-length')
    return new Response(data, { status: response.status, headers: out })
  }
  return response
}
