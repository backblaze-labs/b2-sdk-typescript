/**
 * List all buckets in a B2 account.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx tsx examples/node-list-buckets.ts
 */

import { setupClient } from './_smoke/cli.ts'

async function main() {
  const client = await setupClient()

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
