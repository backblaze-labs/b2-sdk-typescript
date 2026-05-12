/**
 * Download a file from Backblaze B2 to the local filesystem.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx tsx examples/node-download.ts <bucket-name> <file-name> [output-path]
 */

import { writeFile } from 'node:fs/promises'
import { B2Client } from '@backblaze/b2-sdk'

async function main() {
  const bucketName = process.argv[2]
  const fileName = process.argv[3]
  const outputPath = process.argv[4] ?? fileName

  if (!bucketName || !fileName) {
    console.error(
      'Usage: npx tsx examples/node-download.ts <bucket-name> <file-name> [output-path]',
    )
    process.exit(1)
  }

  const keyId = process.env.B2_APPLICATION_KEY_ID
  const key = process.env.B2_APPLICATION_KEY
  if (!keyId || !key) {
    console.error('Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables')
    process.exit(1)
  }

  const client = new B2Client({ applicationKeyId: keyId, applicationKey: key })
  await client.authorize()

  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`Bucket "${bucketName}" not found`)
    process.exit(1)
  }

  console.log(`Downloading ${fileName} from ${bucketName}...`)

  const result = await bucket.download(fileName)
  const reader = result.body.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  let total = 0
  for (const c of chunks) total += c.byteLength
  const combined = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    combined.set(c, offset)
    offset += c.byteLength
  }

  await writeFile(outputPath, combined)
  console.log(`Downloaded ${total} bytes to ${outputPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
