// Persists simulator uploads across CLI processes for backup and restore tests.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { B2Client, BucketType } from '../../src/index.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/index.ts'

const statePath = process.env.REVIEW_STATE
const entries = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : []
const sim = new B2Simulator()
const transport = sim.transport()
const setup = new B2Client({ applicationKeyId: 'test', applicationKey: 'test', transport })
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
function canonical(headers) {
  const out = {}
  for (const [key, value] of new Headers(headers).entries())
    out[key.replace(/(^|-)([a-z])/g, (_m, dash, ch) => dash + ch.toUpperCase())] = value
  return out
}
const localOrigin = 'http://localhost:0'
const podOrigin = 'https://pod-000-0000-00.backblaze.com'
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const parsed = new URL(raw)
  const url = parsed.origin === podOrigin ? localOrigin + parsed.pathname + parsed.search : raw
  const headers = canonical(init.headers ?? {})
  if (
    url.includes('b2_upload_file') &&
    process.env.REVIEW_FAIL_FILE === decodeURIComponent(headers['X-Bz-File-Name'] ?? '')
  ) {
    return new Response(
      JSON.stringify({ status: 400, code: 'bad_request', message: 'simulated upload failure' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  let body = init.body
  if (url.includes('b2_upload_file')) body = new Uint8Array(await new Response(body).arrayBuffer())
  const response = await transport.send({
    url,
    method: init.method ?? 'GET',
    headers,
    ...(body != null ? { body } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  })
  if (url.includes('b2_upload_file') && response.status === 200) {
    const info = {}
    for (const [key, value] of new Headers(init.headers).entries())
      if (key.startsWith('x-bz-info-')) info[key.slice(10)] = decodeURIComponent(value)
    const name = decodeURIComponent(headers['X-Bz-File-Name'])
    const index = entries.findIndex((item) => item.name === name)
    const item = { name, base64: Buffer.from(body).toString('base64'), info }
    if (index < 0) entries.push(item)
    else entries[index] = item
    writeFileSync(statePath, JSON.stringify(entries))
  }
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    let data = (await response.text()).replaceAll(localOrigin, podOrigin)
    if (url.includes('b2_authorize_account') && process.env.REVIEW_API_HOST) {
      const auth = JSON.parse(data)
      auth.apiInfo.storageApi.apiUrl = process.env.REVIEW_API_HOST
      data = JSON.stringify(auth)
    }
    return new Response(data, { status: response.status, headers: response.headers })
  }
  return new Response(response.body, { status: response.status, headers: response.headers })
}
