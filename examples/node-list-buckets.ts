/**
 * List all buckets in a B2 account.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx tsx examples/node-list-buckets.ts
 */

import { B2Client } from '@backblaze/b2-sdk'
import { smokeTransport } from './_smoke/transport.ts'

async function main() {
  const keyId = process.env.B2_APPLICATION_KEY_ID
  const key = process.env.B2_APPLICATION_KEY
  if (!keyId || !key) {
    console.error('Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables')
    process.exit(1)
  }

  const transport = await smokeTransport()
  const client = new B2Client({
    applicationKeyId: keyId,
    applicationKey: key,
    ...(transport !== undefined ? { transport } : {}),
  })
  await client.authorize()

  const buckets = await client.listBuckets()
  console.log(`Found ${buckets.length} bucket(s):\n`)

  for (const bucket of buckets) {
    console.log(`  ${bucket.name}`)
    console.log(`    ID:   ${bucket.id}`)
    console.log(`    Type: ${bucket.info.bucketType}`)
    console.log()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
